const express = require('express');
const router = require('../utils/asyncRouter')(); // catches async errors (see utils/asyncRouter.js)
const pool = require('../config/db');
const { requirePermission } = require('../middleware/auth');
const STATUS_LABELS = require('../constants/statusLabels');
const state = require('../services/workOrderState'); // the only code that changes a job order's status

router.use(requirePermission('toolroom.access')); // who: src/constants/permissions.js

// --- Dashboard: material requests waiting to be checked ---
router.get('/dashboard', async (req, res) => {
  const [pending] = await pool.query(
    `SELECT mr.*, jo.jo_number, jo.machine_name, jo.priority
     FROM material_requests mr
     JOIN job_orders jo ON jo.id = mr.job_order_id
     WHERE mr.status = 'pending'
     ORDER BY FIELD(jo.priority,'urgent','high','normal','low'), mr.created_at ASC`
  );

  const [handled] = await pool.query(
    `SELECT mr.*, jo.jo_number, jo.machine_name
     FROM material_requests mr
     JOIN job_orders jo ON jo.id = mr.job_order_id
     WHERE mr.status IN ('issued','not_available')
     ORDER BY mr.created_at DESC LIMIT 15`
  );

  const [awaitingReceipt] = await pool.query(
    `SELECT po.*, pr.item_name, pr.quantity, pr.unit, jo.jo_number
     FROM purchase_orders po
     JOIN purchase_requisitions pr ON pr.id = po.requisition_id
     JOIN material_requests mr ON mr.id = pr.material_request_id
     JOIN job_orders jo ON jo.id = mr.job_order_id
     WHERE po.status = 'ordered'
     ORDER BY po.created_at ASC`
  );

  res.render('toolroom/dashboard', {
    active: 'dashboard',
    user: req.session.user,
    pending,
    handled,
    awaitingReceipt,
    statusLabels: STATUS_LABELS
  });
});

// --- Inventory list + quick add/restock ---
router.get('/inventory', async (req, res) => {
  const [items] = await pool.query('SELECT * FROM inventory ORDER BY item_name ASC');
  res.render('toolroom/inventory', { user: req.session.user, active: 'inventory', items, error: null });
});

router.post('/inventory', async (req, res) => {
  const { item_name, sku, quantity_on_hand, unit, reorder_level } = req.body;
  if (!item_name || !unit) {
    const [items] = await pool.query('SELECT * FROM inventory ORDER BY item_name ASC');
    return res.render('toolroom/inventory', {
      user: req.session.user, items, error: 'Item name and unit are required.'
    });
  }
  await pool.query(
    `INSERT INTO inventory (item_name, sku, quantity_on_hand, unit, reorder_level)
     VALUES (?, ?, ?, ?, ?)`,
    [item_name, sku || null, quantity_on_hand || 0, unit, reorder_level || 0]
  );
  res.redirect('/toolroom/inventory');
});

router.post('/inventory/:id/restock', async (req, res) => {
  const amount = parseFloat(req.body.amount);
  if (amount && amount > 0) {
    await pool.query(
      'UPDATE inventory SET quantity_on_hand = quantity_on_hand + ? WHERE id = ?',
      [amount, req.params.id]
    );
  }
  res.redirect('/toolroom/inventory');
});

// --- View a single material request, with a live inventory match ---
router.get('/requests/:id', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT mr.*, jo.jo_number, jo.machine_name, jo.priority, jo.id AS job_order_id
     FROM material_requests mr
     JOIN job_orders jo ON jo.id = mr.job_order_id
     WHERE mr.id = ?`,
    [req.params.id]
  );
  if (rows.length === 0) {
    return res.status(404).render('error', { message: 'Request not found.', user: req.session.user });
  }
  const request = rows[0];

  const [invRows] = await pool.query(
    'SELECT * FROM inventory WHERE LOWER(item_name) = LOWER(?)',
    [request.item_name]
  );

  res.render('toolroom/request-detail', {
    user: req.session.user,
    request,
    inventoryMatch: invRows[0] || null,
    error: null
  });
});

// --- Stock is available: issue it and decrement inventory ---
router.post('/requests/:id/issue', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [reqRows] = await conn.query('SELECT * FROM material_requests WHERE id = ? FOR UPDATE', [req.params.id]);
    if (reqRows.length === 0 || reqRows[0].status !== 'pending') {
      await conn.rollback();
      return res.redirect(`/toolroom/requests/${req.params.id}`);
    }
    const request = reqRows[0];

    const [invRows] = await conn.query(
      'SELECT * FROM inventory WHERE LOWER(item_name) = LOWER(?) FOR UPDATE',
      [request.item_name]
    );

    // DECIMAL columns arrive from mysql2 as strings ("10.00"); compare them
    // as numbers, or "10.00" < "3.00" is true and the check goes wrong.
    if (invRows.length === 0 || Number(invRows[0].quantity_on_hand) < Number(request.quantity)) {
      await conn.rollback();
      const [rows] = await pool.query(
        `SELECT mr.*, jo.jo_number, jo.machine_name, jo.priority, jo.id AS job_order_id
         FROM material_requests mr JOIN job_orders jo ON jo.id = mr.job_order_id WHERE mr.id = ?`,
        [req.params.id]
      );
      return res.render('toolroom/request-detail', {
        user: req.session.user,
        request: rows[0],
        inventoryMatch: invRows[0] || null,
        error: 'Not enough stock to issue this. Use "No Stock - Raise Purchase Requisition" instead.'
      });
    }

    await conn.query(
      'UPDATE inventory SET quantity_on_hand = quantity_on_hand - ? WHERE id = ?',
      [request.quantity, invRows[0].id]
    );
    await conn.query(`UPDATE material_requests SET status = 'issued' WHERE id = ?`, [request.id]);
    await state.syncParts(conn, request.job_order_id, {
      event: 'issued', userId: req.session.user.id,
      remarks: `Issued ${request.quantity} ${request.unit} of ${request.item_name} from stock`
    });

    await conn.commit();
    res.redirect(`/toolroom/requests/${req.params.id}`);
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).render('error', { message: 'Could not issue stock. Try again.', user: req.session.user });
  } finally {
    conn.release();
  }
});

// --- No stock: raise a purchase requisition for Purchasing to act on ---
router.post('/requests/:id/not-available', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [reqRows] = await conn.query('SELECT * FROM material_requests WHERE id = ? FOR UPDATE', [req.params.id]);
    if (reqRows.length === 0 || reqRows[0].status !== 'pending') {
      await conn.rollback();
      return res.redirect(`/toolroom/requests/${req.params.id}`);
    }
    const request = reqRows[0];

    await conn.query(`UPDATE material_requests SET status = 'not_available' WHERE id = ?`, [request.id]);

    await conn.query(
      `INSERT INTO purchase_requisitions (material_request_id, raised_by, item_name, quantity, unit, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [request.id, req.session.user.id, request.item_name, request.quantity, request.unit]
    );

    await state.syncParts(conn, request.job_order_id, {
      event: 'awaiting_purchase', userId: req.session.user.id,
      remarks: `No stock for ${request.item_name} - purchase requisition raised`
    });

    await conn.commit();
    res.redirect(`/toolroom/requests/${req.params.id}`);
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).render('error', { message: 'Could not raise the requisition. Try again.', user: req.session.user });
  } finally {
    conn.release();
  }
});

// --- View a purchase order that's on order, and receive it ---
router.get('/purchase-orders/:id', async (req, res) => {
  const [rows] = await pool.query(
    `SELECT po.*, pr.item_name, pr.quantity, pr.unit, jo.jo_number, jo.machine_name
     FROM purchase_orders po
     JOIN purchase_requisitions pr ON pr.id = po.requisition_id
     JOIN material_requests mr ON mr.id = pr.material_request_id
     JOIN job_orders jo ON jo.id = mr.job_order_id
     WHERE po.id = ?`,
    [req.params.id]
  );
  if (rows.length === 0) {
    return res.status(404).render('error', { message: 'Purchase order not found.', user: req.session.user });
  }
  res.render('toolroom/purchase-order-detail', { user: req.session.user, po: rows[0], error: null });
});

// --- Mark a PO as received: stock it, and hand the material request
// back to the normal queue so it can be issued the usual way. ---
router.post('/purchase-orders/:id/receive', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [poRows] = await conn.query(
      `SELECT po.*, pr.id AS requisition_id, pr.material_request_id, pr.item_name, pr.quantity, pr.unit
       FROM purchase_orders po
       JOIN purchase_requisitions pr ON pr.id = po.requisition_id
       WHERE po.id = ? FOR UPDATE`,
      [req.params.id]
    );
    if (poRows.length === 0 || poRows[0].status !== 'ordered') {
      await conn.rollback();
      return res.redirect(`/toolroom/purchase-orders/${req.params.id}`);
    }
    const po = poRows[0];

    // Add the delivered quantity to inventory - either topping up an
    // existing item, or creating a new one if this is the first time
    // it's been stocked.
    const [invRows] = await conn.query(
      'SELECT * FROM inventory WHERE LOWER(item_name) = LOWER(?) FOR UPDATE',
      [po.item_name]
    );
    if (invRows.length > 0) {
      await conn.query(
        'UPDATE inventory SET quantity_on_hand = quantity_on_hand + ? WHERE id = ?',
        [po.quantity, invRows[0].id]
      );
    } else {
      await conn.query(
        `INSERT INTO inventory (item_name, quantity_on_hand, unit, reorder_level) VALUES (?, ?, ?, 0)`,
        [po.item_name, po.quantity, po.unit]
      );
    }

    await conn.query(`UPDATE purchase_orders SET status = 'received' WHERE id = ?`, [po.id]);
    await conn.query(`UPDATE purchase_requisitions SET status = 'completed' WHERE id = ?`, [po.requisition_id]);

    // Put the material request back into the normal Toolroom queue -
    // stock now exists, so it can be issued the same way any other
    // request is, instead of duplicating that logic here.
    const [[mrRow]] = await conn.query(
      'SELECT job_order_id, status FROM material_requests WHERE id = ?',
      [po.material_request_id]
    );
    await conn.query(`UPDATE material_requests SET status = 'pending' WHERE id = ?`, [po.material_request_id]);

    if (mrRow) {
      await state.syncParts(conn, mrRow.job_order_id, {
        event: 'received', userId: req.session.user.id,
        remarks: `${po.po_number} received - ${po.quantity} ${po.unit} of ${po.item_name} added to stock, ready to issue`
      });
    }

    await conn.commit();
    res.redirect(`/toolroom/requests/${po.material_request_id}`);
  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).render('error', { message: 'Could not mark the purchase order received. Try again.', user: req.session.user });
  } finally {
    conn.release();
  }
});

module.exports = router;
