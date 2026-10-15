const express = require('express');
const router = require('../utils/asyncRouter')(); // catches async errors (see utils/asyncRouter.js)
const pool = require('../config/db');
const { requirePermission } = require('../middleware/auth');
const { can } = require('../constants/permissions');
const STATUS_LABELS = require('../constants/statusLabels');
const { ACTIVE_STATUSES } = require('../constants/jobOrderStatus');
const state = require('../services/workOrderState');
const settings = require('../services/settings');
const audit = require('../services/audit');
const dates = require('../utils/dates');

// Who may do what: src/constants/permissions.js. Seeing the Maintenance
// area needs maintenance.view; each action below adds its own check.
router.use(requirePermission('maintenance.view'));

const DUE_SOON_DAYS = 7;

// --- Dashboard: unaccepted queue + jobs this person has accepted ---
router.get('/dashboard', async (req, res) => {
  const [incoming] = await pool.query(
    `SELECT jo.*, u.full_name AS requested_by_name
     FROM job_orders jo
     JOIN users u ON u.id = jo.requested_by
     WHERE jo.status = 'pending'
     ORDER BY FIELD(jo.priority,'urgent','high','normal','low'), jo.created_at ASC`
  );

  const [mine] = await pool.query(
    `SELECT jo.*, u.full_name AS requested_by_name
     FROM job_orders jo
     JOIN users u ON u.id = jo.requested_by
     JOIN maintenance_actions ma ON ma.job_order_id = jo.id
     WHERE ma.accepted_by = ? AND jo.status IN (?)
     ORDER BY jo.updated_at DESC`,
    [req.session.user.id, ACTIVE_STATUSES]
  );

  res.render('maintenance/dashboard', {
    active: 'dashboard',
    user: req.session.user,
    incoming,
    mine,
    statusLabels: STATUS_LABELS
  });
});

// --- One job order, for viewing and acting on ---
async function renderJobOrder(req, res, id, { error = null, form = {}, status = 200 } = {}) {
  const [jobOrders] = await pool.query(
    `SELECT jo.*, u.full_name AS requested_by_name
     FROM job_orders jo
     JOIN users u ON u.id = jo.requested_by
     WHERE jo.id = ?`,
    [id]
  );
  if (jobOrders.length === 0) {
    return res.status(404).render('error', { message: 'Job order not found.', user: req.session.user });
  }
  const jobOrder = jobOrders[0];

  const [history] = await pool.query(
    `SELECT l.*, u.full_name AS changed_by_name
     FROM job_order_status_log l
     JOIN users u ON u.id = l.changed_by
     WHERE l.job_order_id = ? ORDER BY l.created_at ASC, l.id ASC`,
    [id]
  );
  const [materialRequests] = await pool.query(
    `SELECT * FROM material_requests WHERE job_order_id = ? ORDER BY created_at ASC`,
    [id]
  );
  const [actions] = await pool.query(
    `SELECT ma.*, u.full_name AS accepted_by_name
     FROM maintenance_actions ma JOIN users u ON u.id = ma.accepted_by
     WHERE ma.job_order_id = ? ORDER BY ma.id LIMIT 1`,
    [id]
  );
  const action = actions[0] || null;
  const acceptedByMe = !!action && action.accepted_by === req.session.user.id;
  const role = req.session.user.role;

  res.status(status).render('maintenance/job-order-detail', {
    user: req.session.user,
    jobOrder,
    history,
    materialRequests,
    action,
    acceptedByMe,
    // Shown only when the server would also allow it.
    canAccept: jobOrder.status === 'pending' && can(role, 'jobs.accept'),
    canWork: ACTIVE_STATUSES.includes(jobOrder.status)
      && (can(role, 'jobs.work.any') || (acceptedByMe && can(role, 'jobs.work.own'))),
    statusLabels: STATUS_LABELS,
    error,
    form
  });
}

router.get('/job-orders/:id', (req, res) => renderJobOrder(req, res, req.params.id));

// --- Accept a pending job order ---
router.post('/job-orders/:id/accept', requirePermission('jobs.accept'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const job = await state.lock(conn, req.params.id);
    if (!job) {
      await conn.rollback();
      return res.status(404).render('error', { message: 'Job order not found.', user: req.session.user });
    }
    // Refused (and nothing written) if someone else accepted it first.
    await state.move(conn, job, 'accept', { userId: req.session.user.id, remarks: 'Job order accepted by maintenance' });
    await conn.query(
      `INSERT INTO maintenance_actions (job_order_id, accepted_by, notes) VALUES (?, ?, ?)`,
      [job.id, req.session.user.id, req.body.notes || null]
    );
    await conn.commit();
    req.flash('success', `${job.jo_number} accepted. It's now in My Active Jobs.`);
  } catch (err) {
    await conn.rollback();
    if (!(err instanceof state.TransitionError)) throw err;
    req.flash('error', err.message);
  } finally {
    conn.release();
  }
  res.redirect(`/maintenance/job-orders/${req.params.id}`);
});

// Locks a job for a change by whoever is working it. Returns { job } when
// this user may act on it now: the technician who accepted it
// (jobs.work.own) or a Maintenance Manager (jobs.work.any), while it is
// open. Otherwise { status, message } to answer with.
async function lockJobForWorker(conn, jobId, user, doing) {
  const job = await state.lock(conn, jobId);
  if (!job) return { status: 404, message: 'Job order not found.' };
  const refuse = { status: 403, message: `Only the technician who accepted this job, or a Maintenance Manager, can ${doing}, and only while it is open.` };
  if (!ACTIVE_STATUSES.includes(job.status)) return refuse;
  if (can(user.role, 'jobs.work.any')) return { job };
  const [[ma]] = await conn.query(
    'SELECT accepted_by FROM maintenance_actions WHERE job_order_id = ? ORDER BY id LIMIT 1', [jobId]);
  return ma && ma.accepted_by === user.id && can(user.role, 'jobs.work.own') ? { job } : refuse;
}

// --- Request tools/materials from the toolroom ---
router.post('/job-orders/:id/materials', requirePermission('jobs.work.own', 'jobs.work.any'), async (req, res) => {
  const item_name = String(req.body.item_name || '').trim();
  const unit = String(req.body.unit || '').trim();
  const quantity = Number(req.body.quantity);

  if (!item_name || !unit || !req.body.quantity) {
    return renderJobOrder(req, res, req.params.id, { status: 400, form: req.body, error: 'Item name, quantity, and unit are all required.' });
  }
  if (!(quantity > 0) || quantity > 99999999) {
    return renderJobOrder(req, res, req.params.id, { status: 400, form: req.body, error: 'Quantity must be a number greater than 0.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const lock = await lockJobForWorker(conn, req.params.id, req.session.user, 'request materials for it');
    if (!lock.job) {
      await conn.rollback();
      return res.status(lock.status).render('error', { message: lock.message, user: req.session.user });
    }

    await conn.query(
      `INSERT INTO material_requests (job_order_id, requested_by, item_name, quantity, unit, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [req.params.id, req.session.user.id, item_name, quantity, unit]
    );
    await state.syncParts(conn, req.params.id, {
      event: 'tool_requested', userId: req.session.user.id, remarks: `Requested ${quantity} ${unit} of ${item_name}`
    });

    await conn.commit();
    req.flash('success', `Request for ${quantity} ${unit} of ${item_name} sent to the Toolroom.`);
    res.redirect(`/maintenance/job-orders/${req.params.id}`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// --- Mark a job as completed (once tools are issued and work is done) ---
router.post('/job-orders/:id/complete', requirePermission('jobs.work.own', 'jobs.work.any'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const lock = await lockJobForWorker(conn, req.params.id, req.session.user, 'mark it completed');
    if (!lock.job) {
      await conn.rollback();
      return res.status(lock.status).render('error', { message: lock.message, user: req.session.user });
    }
    const job = lock.job;

    await state.move(conn, job, 'complete', { userId: req.session.user.id, remarks: 'Marked completed by maintenance' });
    await conn.query(`UPDATE maintenance_actions SET completed_at = NOW() WHERE job_order_id = ?`, [job.id]);

    await conn.commit();
    req.flash('success', `${job.jo_number} marked completed.`);
    res.redirect(`/maintenance/job-orders/${job.id}`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
});

// ================================================================
// KPI DASHBOARD
// Response time / MTTR / overdue jobs from the Job Order workflow,
// plus PM compliance from the Preventive Maintenance Schedule below.
// Department-wide (not filtered to "my" jobs) since it's meant to
// reflect how the whole Maintenance team is doing.
// ================================================================
router.get('/kpi', requirePermission('maintenance.kpi.view'), async (req, res) => {
  const [[jobStats]] = await pool.query(
    `SELECT
       COUNT(*) AS totalCreated30d
     FROM job_orders WHERE created_at >= NOW() - INTERVAL 30 DAY`
  );

  const [[responseStats]] = await pool.query(
    `SELECT AVG(TIMESTAMPDIFF(MINUTE, jo.created_at, ma.accepted_at)) AS avgResponseMin,
            COUNT(*) AS acceptedCount
     FROM maintenance_actions ma
     JOIN job_orders jo ON jo.id = ma.job_order_id
     WHERE ma.accepted_at >= NOW() - INTERVAL 30 DAY`
  );

  const [[resolutionStats]] = await pool.query(
    `SELECT AVG(TIMESTAMPDIFF(MINUTE, ma.accepted_at, ma.completed_at)) AS avgResolutionMin,
            COUNT(*) AS completedCount
     FROM maintenance_actions ma
     WHERE ma.completed_at IS NOT NULL AND ma.completed_at >= NOW() - INTERVAL 30 DAY`
  );

  const [openByPriority] = await pool.query(
    `SELECT priority, COUNT(*) AS cnt FROM job_orders
     WHERE status IN (?) GROUP BY priority`,
    [ACTIVE_STATUSES]
  );
  const openCounts = { urgent: 0, high: 0, normal: 0, low: 0 };
  openByPriority.forEach(r => { openCounts[r.priority] = r.cnt; });
  const totalOpen = Object.values(openCounts).reduce((a, b) => a + b, 0);

  // Response targets come from Maintenance Settings (migration 004).
  const overdueHours = await settings.overdueHours(pool);
  const [overdueJobs] = await pool.query(
    `SELECT jo.*, u.full_name AS requested_by_name,
            TIMESTAMPDIFF(HOUR, jo.created_at, NOW()) AS hoursOpen
     FROM job_orders jo JOIN users u ON u.id = jo.requested_by
     WHERE jo.status IN (?)
     AND (
       (jo.priority = 'urgent' AND jo.created_at <= NOW() - INTERVAL ? HOUR) OR
       (jo.priority = 'high'   AND jo.created_at <= NOW() - INTERVAL ? HOUR) OR
       (jo.priority = 'normal' AND jo.created_at <= NOW() - INTERVAL ? HOUR) OR
       (jo.priority = 'low'    AND jo.created_at <= NOW() - INTERVAL ? HOUR)
     )
     ORDER BY hoursOpen DESC`,
    [ACTIVE_STATUSES, overdueHours.urgent, overdueHours.high, overdueHours.normal, overdueHours.low]
  );

  // Jobs completed per day, last 7 days, for the trend chart.
  const [dailyRows] = await pool.query(
    `SELECT DATE_FORMAT(completed_at, '%Y-%m-%d') AS d, COUNT(*) AS cnt
     FROM maintenance_actions
     WHERE completed_at IS NOT NULL AND completed_at >= CURDATE() - INTERVAL 6 DAY
     GROUP BY DATE_FORMAT(completed_at, '%Y-%m-%d')`
  );
  const today = dates.today();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const key = dates.addDays(today, -i);
    const row = dailyRows.find(r => r.d === key);
    days.push({ label: dates.weekdayShort(key), count: row ? row.cnt : 0 });
  }
  const maxDaily = Math.max(1, ...days.map(d => d.count));

  // PM compliance, last 30 days: of everything logged done/skipped,
  // what fraction was actioned on or before its due date.
  const [[pmCompliance]] = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN completed_date <= due_date THEN 1 ELSE 0 END) AS onTime
     FROM pm_completions WHERE completed_date >= CURDATE() - INTERVAL 30 DAY`
  );
  const [[pmCounts]] = await pool.query(
    `SELECT
       SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS activeSchedules,
       SUM(CASE WHEN is_active = 1 AND next_due_date < CURDATE() THEN 1 ELSE 0 END) AS overdue,
       SUM(CASE WHEN is_active = 1 AND next_due_date >= CURDATE() AND next_due_date <= CURDATE() + INTERVAL 7 DAY THEN 1 ELSE 0 END) AS dueSoon
     FROM pm_schedules`
  );
  const pmCompliancePct = pmCompliance.total > 0 ? (pmCompliance.onTime / pmCompliance.total) * 100 : null;

  res.render('maintenance/kpi', {
    active: 'kpi',
    user: req.session.user,
    totalCreated30d: jobStats.totalCreated30d,
    avgResponseMin: responseStats.avgResponseMin,
    avgResolutionMin: resolutionStats.avgResolutionMin,
    completedCount30d: resolutionStats.completedCount,
    openCounts,
    totalOpen,
    overdueJobs,
    overdueHours,
    statusLabels: STATUS_LABELS,
    days,
    maxDaily,
    pmCompliancePct,
    pmCompletionsTotal: pmCompliance.total,
    pmCounts: {
      activeSchedules: pmCounts.activeSchedules || 0,
      overdue: pmCounts.overdue || 0,
      dueSoon: pmCounts.dueSoon || 0
    }
  });
});

// ================================================================
// PREVENTIVE MAINTENANCE SCHEDULE (PMS)
// Dates are calendar days in the company time zone (utils/dates.js).
// ================================================================

function pmStatusOf(isActive, due, today) {
  if (!isActive) return 'inactive';
  if (due < today) return 'overdue';
  if (due <= dates.addDays(today, DUE_SOON_DAYS)) return 'due_soon';
  return 'scheduled';
}

async function loadPmSchedules() {
  const [rows] = await pool.query(
    `SELECT pm.*, m.code AS machine_code, m.name AS machine_name
     FROM pm_schedules pm JOIN machines m ON m.id = pm.machine_id
     ORDER BY pm.is_active DESC, pm.next_due_date ASC`
  );
  const today = dates.today();
  return rows.map(r => {
    const due = dates.ymd(r.next_due_date);
    return { ...r, next_due_date: due, last_done_date: dates.ymd(r.last_done_date), pmStatus: pmStatusOf(r.is_active, due, today) };
  });
}

async function renderPmList(req, res, { error = null, form = {}, status = 200 } = {}) {
  const [machines] = await pool.query(`SELECT id, code, name FROM machines WHERE is_active = 1 ORDER BY code`);
  const schedules = await loadPmSchedules();
  res.status(status).render('maintenance/pm-schedules', {
    active: 'pm',
    user: req.session.user,
    machines,
    schedules,
    today: dates.today(),
    error,
    form
  });
}

router.get('/pm', requirePermission('pm.view'), (req, res) => renderPmList(req, res));

router.post('/pm', requirePermission('pm.manage'), async (req, res) => {
  const { machine_id, task_name, description, frequency_days, start_date } = req.body;
  const freq = Number(frequency_days);

  if (!machine_id || !String(task_name || '').trim() || !Number.isInteger(freq) || freq < 1 || freq > 3650) {
    return renderPmList(req, res, { status: 400, form: req.body, error: 'Machine, task name, and a frequency of 1 to 3650 days are required.' });
  }
  if (start_date && !dates.isYmd(start_date)) {
    return renderPmList(req, res, { status: 400, form: req.body, error: 'First due date is not a valid date.' });
  }

  const [r] = await pool.query(
    `INSERT INTO pm_schedules (machine_id, task_name, description, frequency_days, next_due_date, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [machine_id, String(task_name).trim(), description || null, freq, start_date || dates.today(), req.session.user.id]
  );
  req.flash('success', `PM schedule "${String(task_name).trim()}" added.`);
  res.redirect(`/maintenance/pm/${r.insertId}`);
});

async function renderPmDetail(req, res, id, { error = null, status = 200 } = {}) {
  const [rows] = await pool.query(
    `SELECT pm.*, m.code AS machine_code, m.name AS machine_name
     FROM pm_schedules pm JOIN machines m ON m.id = pm.machine_id WHERE pm.id = ?`,
    [id]
  );
  if (rows.length === 0) {
    return res.status(404).render('error', { message: 'PM schedule not found.', user: req.session.user });
  }
  const schedule = rows[0];
  const today = dates.today();
  schedule.next_due_date = dates.ymd(schedule.next_due_date);
  schedule.last_done_date = dates.ymd(schedule.last_done_date);
  schedule.pmStatus = pmStatusOf(schedule.is_active, schedule.next_due_date, today);

  const [history] = await pool.query(
    `SELECT pc.*, u.full_name AS completed_by_name
     FROM pm_completions pc JOIN users u ON u.id = pc.completed_by
     WHERE pc.pm_schedule_id = ? ORDER BY pc.created_at DESC, pc.id DESC`,
    [id]
  );

  res.status(status).render('maintenance/pm-schedule-detail', {
    active: 'pm',
    user: req.session.user,
    schedule,
    history,
    today,
    error
  });
}

router.get('/pm/:id', requirePermission('pm.view'), (req, res) => renderPmDetail(req, res, req.params.id));

// Shared handler for "mark done" / "skip" - both log a pm_completions
// row and roll next_due_date forward by frequency_days from whichever
// is later: the original due date or the actual action date. That
// keeps the schedule from permanently drifting late after one miss,
// while never scheduling the next one in the past. The arithmetic is on
// calendar dates (dates.addDays), so it can't drift by a day.
async function actionPm(req, res, status) {
  const today = dates.today();
  const completedDate = req.body.completed_date || today;
  if (!dates.isYmd(completedDate) || completedDate > today) {
    return renderPmDetail(req, res, req.params.id, { status: 400, error: 'The date must be a real date, today or earlier.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(`SELECT * FROM pm_schedules WHERE id = ? FOR UPDATE`, [req.params.id]);
    if (rows.length === 0) {
      await conn.rollback();
      return res.status(404).render('error', { message: 'PM schedule not found.', user: req.session.user });
    }
    const schedule = rows[0];
    if (!schedule.is_active) {
      await conn.rollback();
      return renderPmDetail(req, res, schedule.id, { status: 409, error: 'This schedule is paused. Reactivate it before logging a cycle.' });
    }
    const dueDate = dates.ymd(schedule.next_due_date);
    const base = completedDate > dueDate ? completedDate : dueDate;
    const nextDue = dates.addDays(base, schedule.frequency_days);

    await conn.query(
      `INSERT INTO pm_completions (pm_schedule_id, due_date, completed_date, status, notes, completed_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [schedule.id, dueDate, completedDate, status, req.body.notes || null, req.session.user.id]
    );
    await conn.query(
      `UPDATE pm_schedules SET last_done_date = ?, next_due_date = ? WHERE id = ?`,
      [completedDate, nextDue, schedule.id]
    );

    await conn.commit();
    req.flash('success', `${status === 'done' ? 'Logged as done' : 'Cycle skipped'}. Next due ${nextDue}.`);
    res.redirect(`/maintenance/pm/${schedule.id}`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

router.post('/pm/:id/complete', requirePermission('pm.complete'), (req, res) => actionPm(req, res, 'done'));
router.post('/pm/:id/skip', requirePermission('pm.complete'), (req, res) => actionPm(req, res, 'skipped'));

router.post('/pm/:id/toggle', requirePermission('pm.manage'), async (req, res) => {
  const [r] = await pool.query(`UPDATE pm_schedules SET is_active = NOT is_active WHERE id = ?`, [req.params.id]);
  if (!r.affectedRows) return res.status(404).render('error', { message: 'PM schedule not found.', user: req.session.user });
  res.redirect(`/maintenance/pm/${req.params.id}`);
});

// ================================================================
// MAINTENANCE SETTINGS
// Response targets (hours before an open job counts as overdue).
// Every change is written to the audit log with old and new values.
// ================================================================

async function renderSettings(req, res, { errors = {}, values = null, reason = '', status = 200 } = {}) {
  const current = await settings.overdueHours(pool);
  const history = await audit.recent(pool, 'maintenance_setting', 20);
  res.status(status).render('maintenance/settings', {
    active: 'settings',
    user: req.session.user,
    priorities: settings.PRIORITIES,
    values: values || current,
    errors,
    reason,
    history,
    canManage: can(req.session.user.role, 'settings.manage')
  });
}

router.get('/settings', requirePermission('settings.view'), (req, res) => renderSettings(req, res));

router.post('/settings', requirePermission('settings.manage'), async (req, res) => {
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  const result = settings.validateOverdueHours(req.body);
  if (result.errors) {
    const entered = {};
    settings.PRIORITIES.forEach(p => { entered[p] = req.body[`overdue_hours_${p}`]; });
    return renderSettings(req, res, { status: 400, errors: result.errors, values: entered, reason });
  }
  const conn = await pool.getConnection();
  let changed;
  try {
    await conn.beginTransaction();
    changed = await settings.saveOverdueHours(conn, result.values, { userId: req.session.user.id, reason });
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  req.flash('success', changed.length ? `Saved. Changed: ${changed.join(', ')}.` : 'No changes to save.');
  res.redirect('/maintenance/settings');
});

module.exports = router;
