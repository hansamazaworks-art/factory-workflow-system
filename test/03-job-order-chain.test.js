// Regression: the cross-department job order chain end to end.
// Production -> Maintenance -> Toolroom -> Purchasing -> (Management) -> Toolroom.
const { resetDb, db } = require('./helpers/setup');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const { login } = require('./helpers/agent');

let conn, prod, maint, tool, purch, boss;
before(async () => {
  await resetDb();
  conn = await db();
  [prod, maint, tool, purch, boss] = await Promise.all(
    ['prod1', 'maint1', 'tool1', 'purch1', 'boss1'].map(u => login(app, u)));
});
after(async () => { await conn.end(); await require('../src/config/db').end(); });

const jo = async id => (await conn.query('SELECT * FROM job_orders WHERE id = ?', [id]))[0][0];
const log = async id => (await conn.query('SELECT status FROM job_order_status_log WHERE job_order_id = ? ORDER BY id', [id]))[0].map(r => r.status);

test('production creates a job order (JO-YYYY-0001, pending)', async () => {
  const res = await prod.post('/production/job-orders', { machine_name: 'IM-01', problem_desc: 'Hydraulic leak', priority: 'high' });
  assert.equal(res.status, 302);
  const j = await jo(1);
  assert.match(j.jo_number, /^JO-\d{4}-0001$/);
  assert.equal(j.status, 'pending');
});

test('job order needs a machine and a description', async () => {
  const res = await prod.post('/production/job-orders', { machine_name: '', problem_desc: '' });
  assert.match(res.text, /required/);
  const [[{ n }]] = await conn.query('SELECT COUNT(*) n FROM job_orders');
  assert.equal(n, 1);
});

test('production can cancel only while pending', async () => {
  await prod.post('/production/job-orders', { machine_name: 'IM-02', problem_desc: 'Noise', priority: 'low' });
  await prod.post('/production/job-orders/2/cancel');
  assert.equal((await jo(2)).status, 'cancelled');
});

test('maintenance accepts, then production can no longer cancel', async () => {
  await maint.post('/maintenance/job-orders/1/accept', { notes: 'On it' });
  assert.equal((await jo(1)).status, 'accepted');
  await prod.post('/production/job-orders/1/cancel');
  assert.equal((await jo(1)).status, 'accepted');
});

test('in-stock request is issued and stock is deducted', async () => {
  await maint.post('/maintenance/job-orders/1/materials', { item_name: 'O-ring 20mm', quantity: 3, unit: 'pcs' });
  assert.equal((await jo(1)).status, 'tool_requested');
  await tool.post('/toolroom/requests/1/issue');
  const [[inv]] = await conn.query("SELECT quantity_on_hand q FROM inventory WHERE item_name = 'O-ring 20mm'");
  assert.equal(Number(inv.q), 7);
  assert.equal((await jo(1)).status, 'issued');
});

test('a request larger than stock is refused (9 in stock, 10 asked): stock never goes negative', async () => {
  await conn.query("INSERT INTO inventory (item_name, quantity_on_hand, unit) VALUES ('Fuse 10A', 9, 'pcs')");
  await maint.post('/maintenance/job-orders/1/materials', { item_name: 'Fuse 10A', quantity: 10, unit: 'pcs' });
  const res = await tool.post('/toolroom/requests/2/issue');
  assert.match(res.text, /Not enough stock/);
  const [[inv]] = await conn.query("SELECT quantity_on_hand q FROM inventory WHERE item_name = 'Fuse 10A'");
  assert.equal(Number(inv.q), 9);
  await tool.post('/toolroom/requests/2/not-available'); // close it out the normal way
});

test('out-of-stock request goes requisition -> auto-approved PO -> ordered -> received -> issued', async () => {
  await maint.post('/maintenance/job-orders/1/materials', { item_name: 'Hose fitting 1/2in', quantity: 2, unit: 'pcs' });
  await tool.post('/toolroom/requests/3/not-available');
  assert.equal((await jo(1)).status, 'awaiting_purchase');

  await purch.post('/purchasing/requisitions/2/create-po', { supplier: 'Acme', unit_price: 100 });
  const [[po]] = await conn.query('SELECT * FROM purchase_orders WHERE id = 1');
  assert.equal(po.status, 'approved'); // 200 < AUTO_APPROVE_LIMIT 5000

  await purch.post('/purchasing/purchase-orders/1/mark-ordered');
  await tool.post('/toolroom/purchase-orders/1/receive');
  const [[inv]] = await conn.query("SELECT quantity_on_hand q FROM inventory WHERE item_name = 'Hose fitting 1/2in'");
  assert.equal(Number(inv.q), 2);

  await tool.post('/toolroom/requests/3/issue');
  // Phase 3 behaviour change (approved plan, section G): the job's status
  // follows ALL its parts. The fuse from the previous test is still waiting
  // on a purchase, so the job stays "Waiting on Purchase Order" instead of
  // claiming "Tools Issued" as it did before.
  const [[fuse]] = await conn.query('SELECT status FROM material_requests WHERE id = 2');
  assert.equal(fuse.status, 'not_available');
  assert.equal((await jo(1)).status, 'awaiting_purchase');
});

test('purchase over the limit waits for management, who approves it', async () => {
  await maint.post('/maintenance/job-orders/1/materials', { item_name: 'Servo motor', quantity: 1, unit: 'pcs' });
  await tool.post('/toolroom/requests/4/not-available');
  await purch.post('/purchasing/requisitions/3/create-po', { supplier: 'Acme', unit_price: 9000 });
  let [[po]] = await conn.query('SELECT * FROM purchase_orders WHERE id = 2');
  assert.equal(po.status, 'pending_approval');
  const res = await boss.post('/management/purchase-orders/2/decide', { decision: 'approved', remarks: 'ok' });
  assert.equal(res.status, 302);
  [[po]] = await conn.query('SELECT * FROM purchase_orders WHERE id = 2');
  assert.equal(po.status, 'approved');
});

test('maintenance completes the job and the timeline holds every step', async () => {
  await maint.post('/maintenance/job-orders/1/complete');
  assert.equal((await jo(1)).status, 'completed');
  assert.deepEqual(await log(1), [
    'pending', 'accepted', 'tool_requested', 'issued',
    'tool_requested', 'awaiting_purchase',
    'tool_requested', 'awaiting_purchase', 'po_created', 'po_approved', 'ordered', 'received', 'issued',
    'tool_requested', 'awaiting_purchase', 'po_created', 'po_approved', 'completed'
  ]);
});

test('job order pages render for each department involved', async () => {
  for (const [a, url] of [[prod, '/production/job-orders/1'], [maint, '/maintenance/job-orders/1'],
    [tool, '/toolroom/requests/1'], [purch, '/purchasing/requisitions/1'], [purch, '/purchasing/purchase-orders/1'],
    [tool, '/toolroom/purchase-orders/1'], [boss, '/management/purchase-orders/2']]) {
    assert.equal((await a.get(url)).status, 200, url);
  }
});
