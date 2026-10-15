const express = require('express');
const router = require('../utils/asyncRouter')(); // catches async errors (see utils/asyncRouter.js)
const pool = require('../config/db');
const { requirePermission } = require('../middleware/auth');
const STATUS_LABELS = require('../constants/statusLabels');
const state = require('../services/workOrderState'); // the only code that changes a job order's status
const dates = require('../utils/dates');
const { computeEntryMetrics, fmtDuration, toHMS, currentShiftId } = require('../utils/floorControl');

// Everything below this line is restricted to the "production" role
// (plus admin, for testing/oversight).
router.use(requirePermission('production.access')); // who: src/constants/permissions.js

// ================================================================
// OVERVIEW DASHBOARD
// ================================================================
router.get('/dashboard', async (req, res) => {
  const [[{ machineCount }]] = await pool.query(`SELECT COUNT(*) AS machineCount FROM machines WHERE is_active = 1`);
  const [[{ runningCount }]] = await pool.query(`SELECT COUNT(*) AS runningCount FROM machines WHERE status = 'running' AND is_active = 1`);
  const [[{ downCount }]] = await pool.query(`SELECT COUNT(*) AS downCount FROM machines WHERE status = 'down' AND is_active = 1`);
  const [[{ openJobOrders }]] = await pool.query(
    `SELECT COUNT(*) AS openJobOrders FROM job_orders WHERE requested_by = ? AND status NOT IN ('completed','cancelled')`,
    [req.session.user.id]
  );
  const [[todayTotals]] = await pool.query(
    `SELECT COALESCE(SUM(machine_opens * cavities_snapshot), 0) AS gross,
            COALESCE(SUM(reject_qty), 0) AS rejects,
            COALESCE(SUM(target_opens * cavities_snapshot), 0) AS targetPieces
     FROM production_entries WHERE entry_date = CURDATE()`
  );
  const achievementPct = todayTotals.targetPieces > 0
    ? (todayTotals.gross / todayTotals.targetPieces) * 100
    : null;

  const [machines] = await pool.query(`SELECT * FROM machines WHERE is_active = 1 ORDER BY code`);
  const [recentJobOrders] = await pool.query(
    `SELECT * FROM job_orders WHERE requested_by = ? ORDER BY created_at DESC LIMIT 5`,
    [req.session.user.id]
  );

  res.render('production/dashboard', {
    user: req.session.user,
    active: 'dashboard',
    stats: {
      machineCount, runningCount, downCount, openJobOrders,
      grossToday: todayTotals.gross, rejectsToday: todayTotals.rejects, achievementPct
    },
    machines,
    recentJobOrders,
    statusLabels: STATUS_LABELS
  });
});

// ================================================================
// JOB ORDERS  (Production -> Maintenance requests)
// ================================================================
router.get('/job-orders', async (req, res) => {
  const [jobOrders] = await pool.query(
    `SELECT * FROM job_orders WHERE requested_by = ? ORDER BY created_at DESC`,
    [req.session.user.id]
  );

  res.render('production/dashboard-joborders', {
    user: req.session.user,
    active: 'job-orders',
    jobOrders,
    statusLabels: STATUS_LABELS
  });
});

router.get('/job-orders/new', (req, res) => {
  res.render('production/create-job-order', {
    user: req.session.user,
    active: 'job-orders',
    error: null,
    form: {}
  });
});

router.post('/job-orders', async (req, res) => {
  const { machine_name, location, problem_desc, priority } = req.body;

  if (!machine_name || !problem_desc) {
    return res.render('production/create-job-order', {
      user: req.session.user,
      active: 'job-orders',
      error: 'Machine/equipment name and problem description are required.',
      form: req.body
    });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Insert first with a temporary jo_number, then fill in the real
    // one using the new row's id so every job order gets a unique,
    // sequential-looking reference number like JO-2026-0001.
    const [result] = await conn.query(
      `INSERT INTO job_orders
        (jo_number, requested_by, machine_name, location, problem_desc, priority, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      ['TEMP', req.session.user.id, machine_name, location || null, problem_desc, priority || 'normal']
    );

    const joNumber = `JO-${new Date().getFullYear()}-${String(result.insertId).padStart(4, '0')}`;

    await conn.query('UPDATE job_orders SET jo_number = ? WHERE id = ?', [joNumber, result.insertId]);

    await conn.query(
      `INSERT INTO job_order_status_log (job_order_id, status, changed_by, remarks)
       VALUES (?, 'pending', ?, 'Job order created')`,
      [result.insertId, req.session.user.id]
    );

    await conn.commit();
    res.redirect(`/production/job-orders/${result.insertId}`);
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.render('production/create-job-order', {
      user: req.session.user,
      active: 'job-orders',
      error: 'Something went wrong saving the job order. Please try again.',
      form: req.body
    });
  } finally {
    conn.release();
  }
});

router.get('/job-orders/:id', async (req, res) => {
  const [jobOrders] = await pool.query(
    `SELECT jo.*, u.full_name AS requested_by_name
     FROM job_orders jo
     JOIN users u ON u.id = jo.requested_by
     WHERE jo.id = ? AND jo.requested_by = ?`,
    [req.params.id, req.session.user.id]
  );

  if (jobOrders.length === 0) {
    return res.status(404).render('error', {
      message: 'Job order not found.',
      user: req.session.user
    });
  }

  const [history] = await pool.query(
    `SELECT l.*, u.full_name AS changed_by_name
     FROM job_order_status_log l
     JOIN users u ON u.id = l.changed_by
     WHERE l.job_order_id = ?
     ORDER BY l.created_at ASC`,
    [req.params.id]
  );

  res.render('production/job-order-detail', {
    user: req.session.user,
    active: 'job-orders',
    jobOrder: jobOrders[0],
    history,
    statusLabels: STATUS_LABELS
  });
});

router.post('/job-orders/:id/cancel', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      `SELECT * FROM job_orders WHERE id = ? AND requested_by = ? FOR UPDATE`,
      [req.params.id, req.session.user.id]
    );

    if (rows.length === 0 || rows[0].status !== 'pending') {
      // Either not yours, doesn't exist, or maintenance already picked
      // it up - in either case, cancelling here isn't allowed.
      await conn.rollback();
      return res.redirect(`/production/job-orders/${req.params.id}`);
    }

    await state.move(conn, rows[0], 'cancel', {
      userId: req.session.user.id, remarks: 'Cancelled by production before maintenance accepted it'
    });

    await conn.commit();
    res.redirect(`/production/job-orders/${req.params.id}`);
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).render('error', { message: 'Could not cancel the job order. Try again.', user: req.session.user });
  } finally {
    conn.release();
  }
});

// ================================================================
// FLOOR CONTROL — shared helpers
// ================================================================

// The mold currently mounted on a machine (unassigned_at IS NULL), or
// null if nothing has been assigned yet.
async function activeAssignmentFor(machineId) {
  const [rows] = await pool.query(
    `SELECT ma.*, m.name AS mold_name, m.product, m.code AS mold_code
     FROM mold_assignments ma
     JOIN molds m ON m.id = ma.mold_id
     WHERE ma.machine_id = ? AND ma.unassigned_at IS NULL
     ORDER BY ma.assigned_at DESC LIMIT 1`,
    [machineId]
  );
  return rows[0] || null;
}

// ================================================================
// FLOOR CONTROL — Live Floor board
// A supervisor works one machine at a time here: Start Run (records
// mold + operator, logs cycle time) -> Log Downtime / Resume as the
// shift goes -> Finish Shift (records the count, writes the historical
// production_entries row Reports/Analytics already read).
// ================================================================

// The open run on a machine (status running or down), with names
// joined in for display, and its currently-open downtime segment (if
// any) attached as .openDowntime.
async function activeRunFor(machineId) {
  const [rows] = await pool.query(
    `SELECT r.*, mo.name AS mold_name, mo.code AS mold_code, mo.product AS mold_product,
            op.name AS operator_name, s.name AS shift_name, u.full_name AS started_by_name
     FROM machine_runs r
     JOIN molds mo ON mo.id = r.mold_id
     JOIN operators op ON op.id = r.operator_id
     JOIN shifts s ON s.id = r.shift_id
     JOIN users u ON u.id = r.started_by
     WHERE r.machine_id = ? AND r.status IN ('running','down')
     ORDER BY r.started_at DESC LIMIT 1`,
    [machineId]
  );
  const run = rows[0] || null;
  if (run && run.status === 'down') {
    const [dtRows] = await pool.query(
      `SELECT * FROM run_downtimes WHERE machine_run_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      [run.id]
    );
    run.openDowntime = dtRows[0] || null;
  }
  return run;
}

const DOWNTIME_REASONS = [
  'Mold change', 'Material shortage', 'Machine breakdown',
  'Power outage', 'Waiting for operator', 'Quality hold', 'Changeover', 'Other'
];

async function renderFloor(req, res, error) {
  const [machines] = await pool.query(`SELECT * FROM machines WHERE is_active = 1 ORDER BY code`);
  const [shifts] = await pool.query(`SELECT * FROM shifts ORDER BY id`);
  const [molds] = await pool.query(`SELECT * FROM molds WHERE is_active = 1 ORDER BY code`);
  const [operators] = await pool.query(`SELECT * FROM operators WHERE is_active = 1 ORDER BY name`);
  const [todaysEntries] = await pool.query(
    `SELECT pe.*, m.name AS machine_name, mo.name AS mold_name, op.name AS operator_name
     FROM production_entries pe
     JOIN machines m ON m.id = pe.machine_id
     JOIN molds mo ON mo.id = pe.mold_id
     JOIN operators op ON op.id = pe.operator_id
     WHERE pe.entry_date = CURDATE()
     ORDER BY pe.created_at DESC`
  );

  const machineCards = await Promise.all(machines.map(async m => ({
    ...m,
    assignment: await activeAssignmentFor(m.id),
    run: await activeRunFor(m.id)
  })));

  res.render('production/floor', {
    user: req.session.user,
    active: 'floor',
    machines: machineCards,
    shifts,
    molds,
    operators,
    todaysEntries,
    downtimeReasons: DOWNTIME_REASONS,
    defaultShiftId: currentShiftId(shifts),
    error: error || null
  });
}

router.get('/floor', async (req, res) => {
  await renderFloor(req, res, null);
});

// ---- Start Run: mounts a mold (if it differs from what's on the
// machine), assigns the operator/shift, and opens a live run. ----
router.post('/floor/:machineId/start', async (req, res) => {
  const machineId = Number(req.params.machineId);
  const { mold_id, operator_id, shift_id, cycle_time_sec } = req.body;

  if (!mold_id || !operator_id || !shift_id) {
    return renderFloor(req, res, 'Mold, operator and shift are all required to start a run.');
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [existingRun] = await conn.query(
      `SELECT id FROM machine_runs WHERE machine_id = ? AND status IN ('running','down') FOR UPDATE`,
      [machineId]
    );
    if (existingRun.length > 0) {
      await conn.rollback();
      return renderFloor(req, res, 'This machine already has an active run. Finish it before starting another.');
    }

    const [currentAssignmentRows] = await conn.query(
      `SELECT * FROM mold_assignments WHERE machine_id = ? AND unassigned_at IS NULL ORDER BY assigned_at DESC LIMIT 1 FOR UPDATE`,
      [machineId]
    );
    const currentAssignment = currentAssignmentRows[0] || null;

    let assignment = currentAssignment;
    if (!currentAssignment || Number(currentAssignment.mold_id) !== Number(mold_id)) {
      const [moldRows] = await conn.query(`SELECT * FROM molds WHERE id = ?`, [mold_id]);
      const mold = moldRows[0];
      if (!mold) {
        await conn.rollback();
        return renderFloor(req, res, 'Select a valid mold.');
      }
      if (currentAssignment) {
        await conn.query(`UPDATE mold_assignments SET unassigned_at = NOW() WHERE id = ?`, [currentAssignment.id]);
      }
      const [insertResult] = await conn.query(
        `INSERT INTO mold_assignments (machine_id, mold_id, cavities_snapshot, standard_cycle_sec, assigned_by, remarks)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [machineId, mold_id, mold.cavities, mold.standard_cycle_sec, req.session.user.id, 'Assigned from Start Run']
      );
      const [newAssignmentRows] = await conn.query(`SELECT * FROM mold_assignments WHERE id = ?`, [insertResult.insertId]);
      assignment = newAssignmentRows[0];
    }

    await conn.query(
      `INSERT INTO machine_runs
        (machine_id, entry_date, shift_id, assignment_id, mold_id, operator_id, cavities_snapshot, cycle_time_sec, status, started_by)
       VALUES (?, CURDATE(), ?, ?, ?, ?, ?, ?, 'running', ?)`,
      [
        machineId, shift_id, assignment.id, assignment.mold_id, operator_id,
        assignment.cavities_snapshot, cycle_time_sec ? Number(cycle_time_sec) : null, req.session.user.id
      ]
    );
    await conn.query(`UPDATE machines SET status = 'running' WHERE id = ?`, [machineId]);

    await conn.commit();
    res.redirect('/production/floor');
  } catch (err) {
    await conn.rollback();
    console.error(err);
    await renderFloor(req, res, 'Could not start the run. Please try again.');
  } finally {
    conn.release();
  }
});

// ---- One-click downtime: punch out (needs a reason), punch back in. ----
router.post('/floor/:machineId/downtime/start', async (req, res) => {
  const machineId = Number(req.params.machineId);
  const { reason, remarks } = req.body;
  if (!reason) {
    return renderFloor(req, res, 'Pick a downtime reason before logging it.');
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [runRows] = await conn.query(
      `SELECT * FROM machine_runs WHERE machine_id = ? AND status = 'running' FOR UPDATE`,
      [machineId]
    );
    const run = runRows[0];
    if (!run) {
      await conn.rollback();
      return renderFloor(req, res, 'No running operation on this machine to mark down.');
    }

    await conn.query(
      `INSERT INTO run_downtimes (machine_run_id, reason, remarks, logged_by) VALUES (?, ?, ?, ?)`,
      [run.id, reason, remarks || null, req.session.user.id]
    );
    await conn.query(`UPDATE machine_runs SET status = 'down' WHERE id = ?`, [run.id]);
    await conn.query(`UPDATE machines SET status = 'down' WHERE id = ?`, [machineId]);

    await conn.commit();
    res.redirect('/production/floor');
  } catch (err) {
    await conn.rollback();
    console.error(err);
    await renderFloor(req, res, 'Could not log downtime. Please try again.');
  } finally {
    conn.release();
  }
});

router.post('/floor/:machineId/downtime/end', async (req, res) => {
  const machineId = Number(req.params.machineId);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [runRows] = await conn.query(
      `SELECT * FROM machine_runs WHERE machine_id = ? AND status = 'down' FOR UPDATE`,
      [machineId]
    );
    const run = runRows[0];
    if (!run) {
      await conn.rollback();
      return renderFloor(req, res, 'No open downtime on this machine to resume from.');
    }
    const [dtRows] = await conn.query(
      `SELECT * FROM run_downtimes WHERE machine_run_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
      [run.id]
    );
    const dt = dtRows[0];
    if (!dt) {
      await conn.rollback();
      return renderFloor(req, res, 'No open downtime segment found for this machine.');
    }

    const now = new Date();
    const startHms = toHMS(new Date(dt.started_at));
    const endHms = toHMS(now);
    await conn.query(`UPDATE run_downtimes SET ended_at = NOW() WHERE id = ?`, [dt.id]);
    // Mirror into downtime_logs so Reports/Analytics (which read that
    // table) see this stoppage without any changes on their end.
    await conn.query(
      `INSERT INTO downtime_logs (machine_id, log_date, shift_id, start_time, end_time, reason, remarks, logged_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [machineId, run.entry_date, run.shift_id, startHms, endHms, dt.reason, dt.remarks, req.session.user.id]
    );
    await conn.query(`UPDATE machine_runs SET status = 'running' WHERE id = ?`, [run.id]);
    await conn.query(`UPDATE machines SET status = 'running' WHERE id = ?`, [machineId]);

    await conn.commit();
    res.redirect('/production/floor');
  } catch (err) {
    await conn.rollback();
    console.error(err);
    await renderFloor(req, res, 'Could not resume. Please try again.');
  } finally {
    conn.release();
  }
});

// ---- Finish Shift: closes the run, computes the same metrics the old
// batch entry form did, and writes the production_entries row Reports/
// Analytics/Dashboard already read. ----
router.post('/floor/:machineId/finish', async (req, res) => {
  const machineId = Number(req.params.machineId);
  const b = req.body;
  const opensMethod = b.opens_method === 'counter' ? 'counter' : 'direct';
  const rejectQty = Number(b.reject_qty) || 0;
  const cycleTimeSec = Number(b.cycle_time_sec) || 0;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [runRows] = await conn.query(
      `SELECT * FROM machine_runs WHERE machine_id = ? AND status IN ('running','down') FOR UPDATE`,
      [machineId]
    );
    const run = runRows[0];
    if (!run) {
      await conn.rollback();
      return renderFloor(req, res, 'No active run on this machine to finish.');
    }

    const now = new Date();

    // Downtime segments already closed during this run...
    const [closedDowntimes] = await conn.query(
      `SELECT * FROM run_downtimes WHERE machine_run_id = ? AND ended_at IS NOT NULL`,
      [run.id]
    );
    const downtimeRows = closedDowntimes.map(d => ({
      start_time: toHMS(new Date(d.started_at)),
      end_time: toHMS(new Date(d.ended_at))
    }));

    // ...plus one still open if the machine was down when Finish was clicked.
    const [openDowntimeRows] = await conn.query(
      `SELECT * FROM run_downtimes WHERE machine_run_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
      [run.id]
    );
    const openDowntime = openDowntimeRows[0];
    if (openDowntime) {
      const startHms = toHMS(new Date(openDowntime.started_at));
      const endHms = toHMS(now);
      await conn.query(`UPDATE run_downtimes SET ended_at = NOW() WHERE id = ?`, [openDowntime.id]);
      await conn.query(
        `INSERT INTO downtime_logs (machine_id, log_date, shift_id, start_time, end_time, reason, remarks, logged_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [machineId, run.entry_date, run.shift_id, startHms, endHms, openDowntime.reason, openDowntime.remarks, req.session.user.id]
      );
      downtimeRows.push({ start_time: startHms, end_time: endHms });
    }

    const startTime = toHMS(new Date(run.started_at));
    const endTime = (b.end_time && /^\d{2}:\d{2}/.test(b.end_time)) ? `${b.end_time}:00` : toHMS(now);

    const cavities = run.cavities_snapshot;
    const computedOpens = opensMethod === 'counter'
      ? Math.max(0, (Number(b.curr_counter) || 0) - (Number(b.prev_counter) || 0))
      : Number(b.machine_opens) || 0;

    if (opensMethod === 'counter' && Number(b.curr_counter) < Number(b.prev_counter)) {
      await conn.rollback();
      return renderFloor(req, res, 'Current counter cannot be lower than the previous counter.');
    }
    const gross = computedOpens * cavities;
    if (rejectQty > gross) {
      await conn.rollback();
      return renderFloor(req, res, 'Reject quantity cannot exceed gross production.');
    }

    const metrics = computeEntryMetrics({
      startTime, endTime, cycleTimeSec, cavities, machineOpens: computedOpens, rejectQty, downtimeRows
    });

    const [entryResult] = await conn.query(
      `INSERT INTO production_entries
        (entry_date, shift_id, machine_id, assignment_id, mold_id, operator_id, start_time, end_time,
         opens_method, prev_counter, curr_counter, machine_opens, cavities_snapshot, cycle_time_sec,
         target_opens, downtime_excluded_min, reject_qty, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        run.entry_date, run.shift_id, machineId, run.assignment_id, run.mold_id, run.operator_id, startTime, endTime,
        opensMethod, opensMethod === 'counter' ? Number(b.prev_counter) : null,
        opensMethod === 'counter' ? Number(b.curr_counter) : null,
        computedOpens, cavities, cycleTimeSec || null, metrics.targetOpens || null,
        metrics.downtimeExcludedMin, rejectQty, b.remarks || null, req.session.user.id
      ]
    );

    await conn.query(
      `UPDATE machine_runs SET status = 'ended', ended_at = NOW(), ended_by = ?, production_entry_id = ? WHERE id = ?`,
      [req.session.user.id, entryResult.insertId, run.id]
    );
    await conn.query(`UPDATE machines SET status = 'idle' WHERE id = ?`, [machineId]);

    await conn.commit();
    res.redirect('/production/floor');
  } catch (err) {
    await conn.rollback();
    console.error(err);
    await renderFloor(req, res, 'Could not finish the shift for this machine. Please try again.');
  } finally {
    conn.release();
  }
});

// ================================================================
// FLOOR CONTROL — Machines
// ================================================================
router.get('/machines', async (req, res) => {
  const [machines] = await pool.query(`SELECT * FROM machines ORDER BY code`);
  const machinesWithAssignment = await Promise.all(machines.map(async m => ({
    ...m,
    assignment: await activeAssignmentFor(m.id)
  })));
  res.render('production/machines', {
    user: req.session.user,
    active: 'machines',
    machines: machinesWithAssignment,
    error: null
  });
});

router.post('/machines', async (req, res) => {
  const { code, name, location } = req.body;
  if (!code || !name) {
    const [machines] = await pool.query(`SELECT * FROM machines ORDER BY code`);
    const machinesWithAssignment = await Promise.all(machines.map(async m => ({ ...m, assignment: await activeAssignmentFor(m.id) })));
    return res.render('production/machines', {
      user: req.session.user, active: 'machines', machines: machinesWithAssignment,
      error: 'Machine code and name are required.'
    });
  }
  try {
    await pool.query(`INSERT INTO machines (code, name, location) VALUES (?, ?, ?)`, [code, name, location || null]);
  } catch (err) {
    console.error(err);
  }
  res.redirect('/production/machines');
});

router.post('/machines/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['running', 'idle', 'down', 'maintenance'].includes(status)) {
    return res.redirect('/production/machines');
  }
  // If this machine has a live run going on the Live Floor board, its
  // status is driven by that run (Start/Downtime/Finish) - manually
  // overriding it here would desync the two. 'maintenance' is still
  // allowed to flag an idle machine as out of service.
  const [activeRun] = await pool.query(
    `SELECT id FROM machine_runs WHERE machine_id = ? AND status IN ('running','down')`,
    [req.params.id]
  );
  if (activeRun.length > 0) {
    const [machines] = await pool.query(`SELECT * FROM machines ORDER BY code`);
    const machinesWithAssignment = await Promise.all(machines.map(async m => ({ ...m, assignment: await activeAssignmentFor(m.id) })));
    return res.render('production/machines', {
      user: req.session.user, active: 'machines', machines: machinesWithAssignment,
      error: 'This machine has a live run on the Live Floor board — finish or resume it there instead of changing status here.'
    });
  }
  await pool.query(`UPDATE machines SET status = ? WHERE id = ?`, [status, req.params.id]);
  res.redirect('/production/machines');
});

// ================================================================
// FLOOR CONTROL — Molds
// ================================================================
router.get('/molds', async (req, res) => {
  const [molds] = await pool.query(`SELECT * FROM molds ORDER BY code`);
  res.render('production/molds', { user: req.session.user, active: 'molds', molds, error: null });
});

router.post('/molds', async (req, res) => {
  const { code, name, product, cavities, standard_cycle_sec } = req.body;
  if (!code || !name || !cavities) {
    const [molds] = await pool.query(`SELECT * FROM molds ORDER BY code`);
    return res.render('production/molds', {
      user: req.session.user, active: 'molds', molds,
      error: 'Mold code, name and cavity count are required.'
    });
  }
  try {
    await pool.query(
      `INSERT INTO molds (code, name, product, cavities, standard_cycle_sec) VALUES (?, ?, ?, ?, ?)`,
      [code, name, product || null, Number(cavities), standard_cycle_sec ? Number(standard_cycle_sec) : null]
    );
  } catch (err) {
    console.error(err);
  }
  res.redirect('/production/molds');
});

// ================================================================
// FLOOR CONTROL — Operators
// ================================================================
router.get('/operators', async (req, res) => {
  const [operators] = await pool.query(`SELECT * FROM operators ORDER BY name`);
  res.render('production/operators', { user: req.session.user, active: 'operators', operators, error: null });
});

router.post('/operators', async (req, res) => {
  const { employee_code, name } = req.body;
  if (!name) {
    const [operators] = await pool.query(`SELECT * FROM operators ORDER BY name`);
    return res.render('production/operators', {
      user: req.session.user, active: 'operators', operators, error: 'Operator name is required.'
    });
  }
  await pool.query(`INSERT INTO operators (employee_code, name) VALUES (?, ?)`, [employee_code || null, name]);
  res.redirect('/production/operators');
});

router.post('/operators/:id/toggle', async (req, res) => {
  await pool.query(`UPDATE operators SET is_active = NOT is_active WHERE id = ?`, [req.params.id]);
  res.redirect('/production/operators');
});

// ================================================================
// FLOOR CONTROL — Mold changes
// ================================================================
router.get('/mold-changes', async (req, res) => {
  const [machines] = await pool.query(`SELECT * FROM machines WHERE is_active = 1 ORDER BY code`);
  const [molds] = await pool.query(`SELECT * FROM molds WHERE is_active = 1 ORDER BY code`);
  const machinesWithAssignment = await Promise.all(machines.map(async m => ({
    ...m,
    assignment: await activeAssignmentFor(m.id)
  })));
  const [history] = await pool.query(
    `SELECT ma.*, m.name AS machine_name, m.code AS machine_code, mo.name AS mold_name, mo.code AS mold_code, u.full_name AS assigned_by_name
     FROM mold_assignments ma
     JOIN machines m ON m.id = ma.machine_id
     JOIN molds mo ON mo.id = ma.mold_id
     JOIN users u ON u.id = ma.assigned_by
     ORDER BY ma.assigned_at DESC LIMIT 30`
  );
  res.render('production/mold-changes', {
    user: req.session.user,
    active: 'mold-changes',
    machines: machinesWithAssignment,
    molds,
    history,
    error: null
  });
});

router.post('/mold-changes', async (req, res) => {
  const { machine_id, mold_id, cavities_override, standard_cycle_override, remarks } = req.body;
  if (!machine_id || !mold_id) {
    return res.redirect('/production/mold-changes');
  }

  const [[mold]] = await pool.query(`SELECT * FROM molds WHERE id = ?`, [mold_id]);
  if (!mold) return res.redirect('/production/mold-changes');

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // Close whatever mold is currently active on this machine.
    await conn.query(
      `UPDATE mold_assignments SET unassigned_at = NOW() WHERE machine_id = ? AND unassigned_at IS NULL`,
      [machine_id]
    );
    await conn.query(
      `INSERT INTO mold_assignments (machine_id, mold_id, cavities_snapshot, standard_cycle_sec, assigned_by, remarks)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        machine_id, mold_id,
        cavities_override ? Number(cavities_override) : mold.cavities,
        standard_cycle_override ? Number(standard_cycle_override) : mold.standard_cycle_sec,
        req.session.user.id, remarks || null
      ]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error(err);
  } finally {
    conn.release();
  }
  res.redirect('/production/mold-changes');
});

// ================================================================
// FLOOR CONTROL — Downtime
// ================================================================
router.get('/downtime', async (req, res) => {
  const [machines] = await pool.query(`SELECT * FROM machines WHERE is_active = 1 ORDER BY code`);
  const [shifts] = await pool.query(`SELECT * FROM shifts ORDER BY id`);
  const [logs] = await pool.query(
    `SELECT d.*, m.name AS machine_name, m.code AS machine_code, u.full_name AS logged_by_name
     FROM downtime_logs d
     JOIN machines m ON m.id = d.machine_id
     JOIN users u ON u.id = d.logged_by
     ORDER BY d.log_date DESC, d.start_time DESC LIMIT 50`
  );
  res.render('production/downtime', {
    user: req.session.user,
    active: 'downtime',
    machines, shifts, logs, error: null,
    form: { log_date: dates.today() }
  });
});

router.post('/downtime', async (req, res) => {
  const { machine_id, log_date, shift_id, start_time, end_time, reason, remarks } = req.body;
  if (!machine_id || !log_date || !start_time || !end_time || !reason) {
    const [machines] = await pool.query(`SELECT * FROM machines WHERE is_active = 1 ORDER BY code`);
    const [shifts] = await pool.query(`SELECT * FROM shifts ORDER BY id`);
    const [logs] = await pool.query(
      `SELECT d.*, m.name AS machine_name, m.code AS machine_code, u.full_name AS logged_by_name
       FROM downtime_logs d JOIN machines m ON m.id = d.machine_id JOIN users u ON u.id = d.logged_by
       ORDER BY d.log_date DESC, d.start_time DESC LIMIT 50`
    );
    return res.render('production/downtime', {
      user: req.session.user, active: 'downtime', machines, shifts, logs,
      error: 'Machine, date, start/end time and reason are required.', form: req.body
    });
  }
  await pool.query(
    `INSERT INTO downtime_logs (machine_id, log_date, shift_id, start_time, end_time, reason, remarks, logged_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [machine_id, log_date, shift_id || null, start_time, end_time, reason, remarks || null, req.session.user.id]
  );
  res.redirect('/production/downtime');
});

// ================================================================
// FLOOR CONTROL — Reports (date-range summary)
// ================================================================
router.get('/reports', async (req, res) => {
  const to = req.query.to || dates.today();
  const from = req.query.from || dates.addDays(dates.today(), -6);

  const [rows] = await pool.query(
    `SELECT m.code AS machine_code, m.name AS machine_name,
            COUNT(pe.id) AS runs,
            COALESCE(SUM(pe.machine_opens * pe.cavities_snapshot), 0) AS gross,
            COALESCE(SUM(pe.reject_qty), 0) AS rejects,
            COALESCE(SUM(pe.target_opens * pe.cavities_snapshot), 0) AS targetPieces,
            COALESCE(SUM(pe.downtime_excluded_min), 0) AS downtimeMin
     FROM machines m
     LEFT JOIN production_entries pe ON pe.machine_id = m.id AND pe.entry_date BETWEEN ? AND ?
     WHERE m.is_active = 1
     GROUP BY m.id ORDER BY m.code`,
    [from, to]
  );

  const summary = rows.map(r => ({
    ...r,
    good: r.gross - r.rejects,
    rejectRatePct: r.gross > 0 ? (r.rejects / r.gross) * 100 : 0,
    achievementPct: r.targetPieces > 0 ? (r.gross / r.targetPieces) * 100 : null
  }));

  const [downtimeByReason] = await pool.query(
    `SELECT reason, COUNT(*) AS occurrences,
            COALESCE(SUM(TIME_TO_SEC(TIMEDIFF(
              CASE WHEN end_time < start_time THEN ADDTIME(end_time, '24:00:00') ELSE end_time END,
              start_time)) / 60), 0) AS totalMin
     FROM downtime_logs
     WHERE log_date BETWEEN ? AND ?
     GROUP BY reason ORDER BY totalMin DESC`,
    [from, to]
  );

  res.render('production/reports', {
    user: req.session.user,
    active: 'reports',
    from, to, summary, downtimeByReason
  });
});

// ================================================================
// FLOOR CONTROL — Analytics (last 7 days trend)
// ================================================================
router.get('/analytics', async (req, res) => {
  const [dailyRows] = await pool.query(
    `SELECT entry_date,
            COALESCE(SUM(machine_opens * cavities_snapshot), 0) AS gross,
            COALESCE(SUM(target_opens * cavities_snapshot), 0) AS targetPieces,
            COALESCE(SUM(reject_qty), 0) AS rejects
     FROM production_entries
     WHERE entry_date >= CURDATE() - INTERVAL 6 DAY
     GROUP BY entry_date ORDER BY entry_date`
  );

  // Fill in any missing days (no entries logged) so the chart always
  // shows a full 7-day window.
  // Days are calendar dates in the company time zone (utils/dates.js).
  const today = dates.today();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const key = dates.addDays(today, -i);
    const row = dailyRows.find(r => dates.ymd(r.entry_date) === key);
    days.push({
      date: key,
      label: dates.weekdayShort(key),
      gross: row ? row.gross : 0,
      targetPieces: row ? row.targetPieces : 0,
      rejects: row ? row.rejects : 0
    });
  }
  const maxValue = Math.max(1, ...days.map(d => Math.max(d.gross, d.targetPieces)));

  const [downtimeByReason] = await pool.query(
    `SELECT reason, COUNT(*) AS occurrences,
            COALESCE(SUM(TIME_TO_SEC(TIMEDIFF(
              CASE WHEN end_time < start_time THEN ADDTIME(end_time, '24:00:00') ELSE end_time END,
              start_time)) / 60), 0) AS totalMin
     FROM downtime_logs
     WHERE log_date >= CURDATE() - INTERVAL 6 DAY
     GROUP BY reason ORDER BY totalMin DESC LIMIT 8`
  );
  const maxDowntime = Math.max(1, ...downtimeByReason.map(r => r.totalMin));

  const [[topline]] = await pool.query(
    `SELECT COALESCE(SUM(machine_opens * cavities_snapshot), 0) AS gross,
            COALESCE(SUM(reject_qty), 0) AS rejects,
            COALESCE(SUM(target_opens * cavities_snapshot), 0) AS targetPieces
     FROM production_entries WHERE entry_date >= CURDATE() - INTERVAL 6 DAY`
  );
  const weekAchievementPct = topline.targetPieces > 0 ? (topline.gross / topline.targetPieces) * 100 : null;
  const weekRejectRatePct = topline.gross > 0 ? (topline.rejects / topline.gross) * 100 : 0;

  res.render('production/analytics', {
    user: req.session.user,
    active: 'analytics',
    days, maxValue, downtimeByReason, maxDowntime,
    topline, weekAchievementPct, weekRejectRatePct
  });
});

module.exports = router;
