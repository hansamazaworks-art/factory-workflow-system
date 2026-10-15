const express = require('express');
const router = require('../utils/asyncRouter')(); // catches async errors (see utils/asyncRouter.js)
const pool = require('../config/db');
const { requirePermission } = require('../middleware/auth');
const STATUS_LABELS = require('../constants/statusLabels');

router.use(requirePermission('purchasing.access')); // who: src/constants/permissions.js

// --- Dashboard: open requisitions + recent POs and their approval status ---
router.get('/dashboard', async (req, res) => {
  const [open] = await pool.query(
    `SELECT pr.*, jo.jo_number, jo.machine_name, jo.priority
     FROM purchase_requisitions pr
     JOIN material_requests mr ON mr.id = pr.material_request_id
     JOIN job_orders jo ON jo.id = mr.job_order_id
     WHERE pr.status = 'pending'
     ORDER BY FIELD(jo.priority,'urgent','high','normal','low'), pr.created_at ASC`
  );

  const [recentPOs] = await pool.query(
    `SELECT po.*, pr.item_name, pr.quantity, pr.unit
     FROM purchase_orders po
     JOIN purchase_requisitions pr ON pr.id = po.requisition_id
     ORDER BY po.created_at DESC LIMIT 15`
  );

  res.render('purchasing/dashboard', {
    active: 'dashboard',
    user: req.session.user,
    open,
    recentPOs
  });
});

// --- View a single requisition and create a PO for it ---
router.get('/requisitions/:id', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT pr.*, jo.jo_number, jo.machine_name, jo.priority, jo.id AS job_order_id
     FROM purchase_requisitions pr
     JOIN material_requests mr ON mr.id = pr.material_request_id
     JOIN job_orders jo ON jo.id = mr.job_order_id
     WHERE pr.id = ?`,
    [req.params.id]
  );
  if (rows.length === 0) {
    return res.status(404).render('error', { message: 'Requisition not found.', user: req.session.user });
  }
  res.render('purchasing/requisition-detail', {
    user: req.session.user,
    requisition: rows[0],
    error: null,
    form: {}
  });
});

// --- Create the purchase order ---
router.post('/requisitions/:id/create-po', async (req, res) => {
  const { supplier, unit_price } = req.body;
  const price = parseFloat(unit_price);

  if (!supplier || !unit_price || isNaN(price) || price <= 0) {
    const [rows] = await pool.query(
      `SELECT pr.*, jo.jo_number, jo.machine_name, jo.priority, jo.id AS job_order_id
       FROM purchase_requisitions pr
       JOIN material_requests mr ON mr.id = pr.material_request_id
       JOIN job_orders jo ON jo.id = mr.job_order_id
       WHERE pr.id = ?`,
      [req.params.id]
    );
    return res.render('purchasing/requisition-detail', {
      user: req.session.user,
      requisition: rows[0],
      error: 'Supplier and a valid unit price are required.',
      form: req.body
    });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [reqRows] = await conn.query('SELECT * FROM purchase_requisitions WHERE id = ? FOR UPDATE', [req.params.id]);
    if (reqRows.length === 0 || reqRows[0].status !== 'pending') {
      await conn.rollback();
      return res.redirect(`/purchasing/requisitions/${req.params.id}`);
    }
    const requisition = reqRows[0];
    const totalAmount = price * parseFloat(requisition.quantity);

    // Spending limit: small purchases don't need to wait on Management.
    // Anything at or above the threshold still goes through the normal
    // approval queue. Set AUTO_APPROVE_LIMIT=0 in .env to require
    // approval on every purchase order, regardless of amount.
    const autoApproveLimit = parseFloat(process.env.AUTO_APPROVE_LIMIT || '0');
    const autoApprove = autoApproveLimit > 0 && totalAmount < autoApproveLimit;
    const initialStatus = autoApprove ? 'approved' : 'pending_approval';

    const [result] = await conn.query(
      `INSERT INTO purchase_orders
        (requisition_id, po_number, created_by, supplier, unit_price, total_amount, status)
       VALUES (?, 'TEMP', ?, ?, ?, ?, ?)`,
      [requisition.id, req.session.user.id, supplier, price, totalAmount, initialStatus]
    );

    const poNumber = `PO-${new Date().getFullYear()}-${String(result.insertId).padStart(4, '0')}`;
    await conn.query('UPDATE purchase_orders SET po_number = ? WHERE id = ?', [poNumber, result.insertId]);

    await conn.query(`UPDATE purchase_requisitions SET status = 'po_created' WHERE id = ?`, [requisition.id]);

    // Find the job order this traces back to, so the timeline stays linked end-to-end.
    const [[mr]] = await conn.query(
      `SELECT jo.id AS job_order_id FROM material_requests mr
       JOIN job_orders jo ON jo.id = mr.job_order_id WHERE mr.id = ?`,
      [requisition.material_request_id]
    );

    await conn.query(
      `INSERT INTO job_order_status_log (job_order_id, status, changed_by, remarks)
       VALUES (?, 'po_created', ?, ?)`,
      [mr.job_order_id, req.session.user.id, `${poNumber} created (${supplier}, ${totalAmount.toFixed(2)})${autoApprove ? ' - auto-approved (under spending limit)' : ' - pending management approval'}`]
    );

    if (autoApprove) {
      await conn.query(
        `INSERT INTO approvals (purchase_order_id, decided_by, decision, remarks)
         VALUES (?, ?, 'approved', 'Auto-approved: total was under the spending limit')`,
        [result.insertId, req.session.user.id]
      );
      await conn.query(
        `INSERT INTO job_order_status_log (job_order_id, status, changed_by, remarks)
         VALUES (?, 'po_approved', ?, ?)`,
        [mr.job_order_id, req.session.user.id, `${poNumber} auto-approved - total was under the spending limit`]
      );
    }

    await conn.commit();
    res.redirect(`/purchasing/purchase-orders/${result.insertId}`);
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).render('error', { message: 'Could not create the purchase order. Try again.', user: req.session.user });
  } finally {
    conn.release();
  }
});

// --- View a single purchase order (read-only tracking) ---
router.get('/purchase-orders/:id', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT po.*, pr.item_name, pr.quantity, pr.unit, u.full_name AS created_by_name
     FROM purchase_orders po
     JOIN purchase_requisitions pr ON pr.id = po.requisition_id
     JOIN users u ON u.id = po.created_by
     WHERE po.id = ?`,
    [req.params.id]
  );
  if (rows.length === 0) {
    return res.status(404).render('error', { message: 'Purchase order not found.', user: req.session.user });
  }

  const [approvals] = await pool.query(
    `SELECT a.*, u.full_name AS decided_by_name FROM approvals a
     JOIN users u ON u.id = a.decided_by WHERE a.purchase_order_id = ?`,
    [req.params.id]
  );

  res.render('purchasing/purchase-order-detail', {
    user: req.session.user,
    po: rows[0],
    approval: approvals[0] || null
  });
});

// --- Mark an approved PO as ordered (placed with the supplier) ---
router.post('/purchase-orders/:id/mark-ordered', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [poRows] = await conn.query('SELECT * FROM purchase_orders WHERE id = ? FOR UPDATE', [req.params.id]);
    if (poRows.length === 0 || poRows[0].status !== 'approved') {
      await conn.rollback();
      return res.redirect(`/purchasing/purchase-orders/${req.params.id}`);
    }
    const po = poRows[0];

    await conn.query(`UPDATE purchase_orders SET status = 'ordered' WHERE id = ?`, [po.id]);

    const [[link]] = await conn.query(
      `SELECT jo.id AS job_order_id FROM purchase_requisitions pr
       JOIN material_requests mr ON mr.id = pr.material_request_id
       JOIN job_orders jo ON jo.id = mr.job_order_id
       WHERE pr.id = ?`,
      [po.requisition_id]
    );

    await conn.query(
      `INSERT INTO job_order_status_log (job_order_id, status, changed_by, remarks)
       VALUES (?, 'ordered', ?, ?)`,
      [link.job_order_id, req.session.user.id, `${po.po_number} placed with supplier (${po.supplier})`]
    );

    await conn.commit();
    res.redirect(`/purchasing/purchase-orders/${req.params.id}`);
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).render('error', { message: 'Could not update the purchase order. Try again.', user: req.session.user });
  } finally {
    conn.release();
  }
});

module.exports = router;
