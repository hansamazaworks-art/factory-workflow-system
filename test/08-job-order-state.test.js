// Phase 3: every job order status change goes through one service that
// refuses impossible moves and records from/to on the timeline.
const { resetDb, db } = require('./helpers/setup');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const { login } = require('./helpers/agent');
const state = require('../src/services/workOrderState');

let conn, prod, maint, maint2, tool, purch;
before(async () => {
  await resetDb();
  conn = await db();
  [prod, maint, maint2, tool, purch] = await Promise.all(['prod1', 'maint1', 'maint2', 'tool1', 'purch1'].map(u => login(app, u)));
});
after(async () => { await conn.end(); await require('../src/config/db').end(); });

const status = async id => (await conn.query('SELECT status FROM job_orders WHERE id = ?', [id]))[0][0].status;
const lastLog = async id => (await conn.query('SELECT status, from_status, to_status FROM job_order_status_log WHERE job_order_id = ? ORDER BY id DESC LIMIT 1', [id]))[0][0];
let n = 0;
async function newJob() {
  n++;
  await prod.post('/production/job-orders', { machine_name: 'IM-01', problem_desc: `State test ${n}`, priority: 'normal' });
  const [[j]] = await conn.query('SELECT id FROM job_orders WHERE problem_desc = ?', [`State test ${n}`]);
  return j.id;
}
const lastRequestId = async () => (await conn.query('SELECT MAX(id) id FROM material_requests'))[0][0].id;

test('parts status rule: no stock wins, then anything still with the Toolroom, then all issued', () => {
  assert.equal(state.partsStatus([]), null);
  assert.equal(state.partsStatus(['issued']), 'issued');
  assert.equal(state.partsStatus(['issued', 'pending']), 'tool_requested');
  assert.equal(state.partsStatus(['issued', 'not_available', 'pending']), 'awaiting_purchase');
});

test('status changes record where they came from and went to', async () => {
  const id = await newJob();
  await maint.post(`/maintenance/job-orders/${id}/accept`);
  assert.deepEqual({ ...(await lastLog(id)) }, { status: 'accepted', from_status: 'pending', to_status: 'accepted' });
  await maint.post(`/maintenance/job-orders/${id}/complete`);
  assert.deepEqual({ ...(await lastLog(id)) }, { status: 'completed', from_status: 'accepted', to_status: 'completed' });
  const id2 = await newJob();
  await prod.post(`/production/job-orders/${id2}/cancel`);
  assert.deepEqual({ ...(await lastLog(id2)) }, { status: 'cancelled', from_status: 'pending', to_status: 'cancelled' });
});

test('two technicians accepting the same job at the same moment: exactly one gets it', async () => {
  const id = await newJob();
  const results = await Promise.all([
    maint.post(`/maintenance/job-orders/${id}/accept`),
    maint2.post(`/maintenance/job-orders/${id}/accept`)
  ]);
  results.forEach(r => assert.equal(r.status, 302));
  const [actions] = await conn.query('SELECT accepted_by FROM maintenance_actions WHERE job_order_id = ?', [id]);
  assert.equal(actions.length, 1);
  const [[{ c }]] = await conn.query("SELECT COUNT(*) c FROM job_order_status_log WHERE job_order_id = ? AND status = 'accepted'", [id]);
  assert.equal(c, 1);
  // The one who lost is told why on the next page they see.
  const loser = actions[0].accepted_by === (await conn.query("SELECT id FROM users WHERE username='maint1'"))[0][0].id ? maint2 : maint;
  assert.match((await loser.get(`/maintenance/job-orders/${id}`)).text, /can&#39;t be accepted now|can't be accepted now/);
});

test('issuing a leftover part for a COMPLETED job no longer reopens it (bug in the original code)', async () => {
  const id = await newJob();
  await maint.post(`/maintenance/job-orders/${id}/accept`);
  await maint.post(`/maintenance/job-orders/${id}/materials`, { item_name: 'O-ring 20mm', quantity: 1, unit: 'pcs' });
  const req = await lastRequestId();
  await maint.post(`/maintenance/job-orders/${id}/complete`);
  assert.equal(await status(id), 'completed');

  await tool.post(`/toolroom/requests/${req}/issue`);
  assert.equal(await status(id), 'completed', 'stays completed');
  assert.deepEqual({ ...(await lastLog(id)) }, { status: 'issued', from_status: null, to_status: null }, 'event recorded, no status change');
  const [[inv]] = await conn.query("SELECT quantity_on_hand q FROM inventory WHERE item_name = 'O-ring 20mm'");
  assert.equal(Number(inv.q), 9, 'stock was still issued');
});

test('a job shows "Waiting on Purchase Order" until every part it needs is in', async () => {
  const id = await newJob();
  await maint.post(`/maintenance/job-orders/${id}/accept`);
  await maint.post(`/maintenance/job-orders/${id}/materials`, { item_name: 'Bearing 6204', quantity: 2, unit: 'pcs' });
  const bearing = await lastRequestId();
  await maint.post(`/maintenance/job-orders/${id}/materials`, { item_name: 'O-ring 20mm', quantity: 1, unit: 'pcs' });
  const oring = await lastRequestId();

  await tool.post(`/toolroom/requests/${bearing}/not-available`);
  assert.equal(await status(id), 'awaiting_purchase');
  await tool.post(`/toolroom/requests/${oring}/issue`);
  assert.equal(await status(id), 'awaiting_purchase', 'O-ring issued, bearing still on order');

  const [[reqn]] = await conn.query('SELECT id FROM purchase_requisitions WHERE material_request_id = ?', [bearing]);
  await purch.post(`/purchasing/requisitions/${reqn.id}/create-po`, { supplier: 'Acme', unit_price: 50 });
  const [[po]] = await conn.query('SELECT id FROM purchase_orders WHERE requisition_id = ?', [reqn.id]);
  await purch.post(`/purchasing/purchase-orders/${po.id}/mark-ordered`);
  await tool.post(`/toolroom/purchase-orders/${po.id}/receive`);
  assert.equal(await status(id), 'tool_requested', 'bearing received, waiting to be issued');
  assert.deepEqual({ ...(await lastLog(id)) }, { status: 'received', from_status: 'awaiting_purchase', to_status: 'tool_requested' });

  await tool.post(`/toolroom/requests/${bearing}/issue`);
  assert.equal(await status(id), 'issued', 'everything issued');
});

test('the service refuses impossible moves and writes nothing', async () => {
  const id = await newJob();
  await prod.post(`/production/job-orders/${id}/cancel`);
  const c = await db();
  try {
    await c.beginTransaction();
    const job = await state.lock(c, id);
    await assert.rejects(state.move(c, job, 'complete', { userId: 1 }), state.TransitionError);
    await assert.rejects(state.move(c, job, 'accept', { userId: 1 }), /can't be accepted now/);
    await c.rollback();
  } finally { await c.end(); }
  assert.equal(await status(id), 'cancelled');
});

test('only the state service changes job_orders.status anywhere in the code', () => {
  const fs = require('fs');
  const path = require('path');
  const offenders = [];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return walk(p);
    if (!p.endsWith('.js') || p.endsWith('workOrderState.js')) return;
    if (/UPDATE\s+job_orders\s+SET\s+[^;`]*\bstatus\b/i.test(fs.readFileSync(p, 'utf8'))) offenders.push(p);
  });
  walk(path.join(__dirname, '..', 'src'));
  assert.deepEqual(offenders, []);
});
