const express = require('express');
const router = require('../utils/asyncRouter')(); // catches async errors (see utils/asyncRouter.js)
const pool = require('../config/db');
const { requirePermission } = require('../middleware/auth');

router.use(requirePermission('management.access')); // who: src/constants/permissions.js

// --- Dashboard: purchase orders waiting on a decision ---
router.get('/dashboard', async (req, res) => {
  const [pending] = await pool.query(
    `SELECT po.*, pr.item_name, pr.quantity, pr.unit, jo.jo_number, jo.machine_name, jo.priority, u.full_name AS created_by_name
     FROM purchase_orders po
     JOIN purchase_requisitions pr ON pr.id = po.requisition_id
     JOIN material_requests mr ON mr.id = pr.material_request_id
     JOIN job_orders jo ON jo.id = mr.job_order_id
     JOIN users u ON u.id = po.created_by
     WHERE po.status = 'pending_approval'
     ORDER BY FIELD(jo.priority,'urgent','high','normal','low'), po.created_at ASC`
  );

  const [decided] = await pool.query(
    `SELECT po.*, pr.item_name, a.decision, a.decided_at
     FROM purchase_orders po
     JOIN purchase_requisitions pr ON pr.id = po.requisition_id
     JOIN approvals a ON a.purchase_order_id = po.id
     ORDER BY a.decided_at DESC LIMIT 15`
  );

  res.render('management/dashboard', {
    active: 'dashboard',
    user: req.session.user,
    pending,
    decided
  });
});

// --- View a single PO and decide on it ---
router.get('/purchase-orders/:id', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT po.*, pr.item_name, pr.quantity, pr.unit, jo.jo_number, jo.machine_name, jo.problem_desc,
            u.full_name AS created_by_name
     FROM purchase_orders po
     JOIN purchase_requisitions pr ON pr.id = po.requisition_id
     JOIN material_requests mr ON mr.id = pr.material_request_id
     JOIN job_orders jo ON jo.id = mr.job_order_id
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

  res.render('management/purchase-order-detail', {
    user: req.session.user,
    po: rows[0],
    approval: approvals[0] || null,
    error: null
  });
});

// --- Approve or reject ---
router.post('/purchase-orders/:id/decide', async (req, res) => {
  const { decision, remarks } = req.body;

  if (!['approved', 'rejected'].includes(decision)) {
    return res.redirect(`/management/purchase-orders/${req.params.id}`);
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [poRows] = await conn.query('SELECT * FROM purchase_orders WHERE id = ? FOR UPDATE', [req.params.id]);
    if (poRows.length === 0 || poRows[0].status !== 'pending_approval') {
      await conn.rollback();
      return res.redirect(`/management/purchase-orders/${req.params.id}`);
    }
    const po = poRows[0];

    await conn.query(
      `INSERT INTO approvals (purchase_order_id, decided_by, decision, remarks) VALUES (?, ?, ?, ?)`,
      [po.id, req.session.user.id, decision, remarks || null]
    );

    await conn.query('UPDATE purchase_orders SET status = ? WHERE id = ?', [decision, po.id]);

    // Trace back to the job order so the timeline stays end-to-end.
    const [[link]] = await conn.query(
      `SELECT jo.id AS job_order_id FROM purchase_requisitions pr
       JOIN material_requests mr ON mr.id = pr.material_request_id
       JOIN job_orders jo ON jo.id = mr.job_order_id
       WHERE pr.id = ?`,
      [po.requisition_id]
    );

    const logStatus = decision === 'approved' ? 'po_approved' : 'po_rejected';
    const logRemark = decision === 'approved'
      ? `${po.po_number} approved by management${remarks ? ' - ' + remarks : ''}`
      : `${po.po_number} rejected by management${remarks ? ' - ' + remarks : ''}`;

    await conn.query(
      `INSERT INTO job_order_status_log (job_order_id, status, changed_by, remarks) VALUES (?, ?, ?, ?)`,
      [link.job_order_id, logStatus, req.session.user.id, logRemark]
    );

    await conn.commit();
    res.redirect(`/management/purchase-orders/${req.params.id}`);
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).render('error', { message: 'Could not record the decision. Try again.', user: req.session.user });
  } finally {
    conn.release();
  }
});

module.exports = router;
