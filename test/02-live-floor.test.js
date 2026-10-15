// Regression: Live Floor run cycle, downtime mirroring, and the rule that a
// machine with a live run can't have its status changed by hand.
const { resetDb, db } = require('./helpers/setup');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const { login } = require('./helpers/agent');

let conn, prod;
before(async () => { await resetDb(); conn = await db(); prod = await login(app, 'prod1'); });
after(async () => { await conn.end(); await require('../src/config/db').end(); });

const status = async id => (await conn.query('SELECT status FROM machines WHERE id = ?', [id]))[0][0].status;

test('start run mounts the mold, opens a run and sets the machine running', async () => {
  const res = await prod.post('/production/floor/1/start', { mold_id: 1, operator_id: 1, shift_id: 1, cycle_time_sec: 12.5 });
  assert.equal(res.status, 302);
  assert.equal(await status(1), 'running');
  const [[run]] = await conn.query("SELECT * FROM machine_runs WHERE machine_id = 1 AND status = 'running'");
  assert.ok(run);
  const [[asg]] = await conn.query('SELECT * FROM mold_assignments WHERE machine_id = 1 AND unassigned_at IS NULL');
  assert.equal(asg.mold_id, 1);
});

test('a second start on the same machine is refused', async () => {
  const res = await prod.post('/production/floor/1/start', { mold_id: 1, operator_id: 2, shift_id: 1 });
  assert.match(res.text, /already has an active run/);
  const [[{ n }]] = await conn.query("SELECT COUNT(*) n FROM machine_runs WHERE machine_id = 1 AND status IN ('running','down')");
  assert.equal(n, 1);
});

test('manual status change is blocked while a live run exists', async () => {
  const res = await prod.post('/production/machines/1/status', { status: 'idle' });
  assert.match(res.text, /live run on the Live Floor board/);
  assert.equal(await status(1), 'running');
});

test('downtime start and end mirror one row into downtime_logs', async () => {
  await prod.post('/production/floor/1/downtime/start', { reason: 'Machine breakdown' });
  assert.equal(await status(1), 'down');
  await prod.post('/production/floor/1/downtime/end');
  assert.equal(await status(1), 'running');
  const [rows] = await conn.query('SELECT * FROM downtime_logs WHERE machine_id = 1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'Machine breakdown');
});

test('finish shift writes one production entry and frees the machine', async () => {
  const res = await prod.post('/production/floor/1/finish', { opens_method: 'direct', machine_opens: 100, reject_qty: 4, cycle_time_sec: 12.5 });
  assert.equal(res.status, 302);
  assert.equal(await status(1), 'idle');
  const [[pe]] = await conn.query('SELECT * FROM production_entries WHERE machine_id = 1');
  assert.equal(pe.machine_opens, 100);
  assert.equal(pe.reject_qty, 4);
  assert.equal(pe.cavities_snapshot, 8);
  const [[run]] = await conn.query('SELECT * FROM machine_runs WHERE machine_id = 1');
  assert.equal(run.status, 'ended');
  assert.equal(run.production_entry_id, pe.id);
});

test('reports show the run: 100 opens x 8 cavities = 800 gross, 796 good', async () => {
  const res = await prod.get('/production/reports?from=2000-01-01&to=2100-12-31');
  assert.equal(res.status, 200);
  const row = res.text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(row, /Injection Molder #1 \(IM-01\) 1 800 796/);
});

test('manual status change works again once the run is finished', async () => {
  await prod.post('/production/machines/2/status', { status: 'maintenance' });
  assert.equal(await status(2), 'maintenance');
});

test('catalogue forms still add machines, molds and operators', async () => {
  await prod.post('/production/machines', { code: 'IM-09', name: 'Test Machine', location: 'Line 9' });
  await prod.post('/production/molds', { code: 'MLD-900', name: 'Mold 900', product: 'Test', cavities: 2, standard_cycle_sec: 10 });
  await prod.post('/production/operators', { name: 'Operator Three' });
  const [[m]] = await conn.query("SELECT COUNT(*) n FROM machines WHERE code = 'IM-09'");
  const [[o]] = await conn.query("SELECT COUNT(*) n FROM molds WHERE code = 'MLD-900'");
  const [[p]] = await conn.query("SELECT COUNT(*) n FROM operators WHERE name = 'Operator Three'");
  assert.deepEqual([m.n, o.n, p.n], [1, 1, 1]);
});
