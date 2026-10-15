// Phase 3: Maintenance Settings drive the KPI overdue list; every change
// is audited. Account administration from the command line.
const { resetDb, db, TEST_DB } = require('./helpers/setup');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const bcrypt = require('bcryptjs');
const app = require('../src/app');
const pool = require('../src/config/db');
const migrator = require('../src/db/migrator');
const users = require('../src/services/users');
const { anonymous, login } = require('./helpers/agent');

let conn, prod, mmgr, plant;
before(async () => {
  await resetDb();
  conn = await db();
  [prod, mmgr, plant] = await Promise.all(['prod1', 'mmgr1', 'plant1'].map(u => login(app, u)));
});
after(async () => { await conn.end(); await pool.end(); });

const targets = { overdue_hours_urgent: 4, overdue_hours_high: 24, overdue_hours_normal: 72, overdue_hours_low: 168 };
const overdueList = async a => {
  const html = (await a.get('/maintenance/kpi')).text;
  const i = html.indexOf('Overdue Job Orders');
  return html.slice(i);
};

test('the KPI overdue list follows the targets on the Settings page', async () => {
  await prod.post('/production/job-orders', { machine_name: 'IM-01', problem_desc: 'Settings test', priority: 'normal' });
  await (await login(app, 'maint1')).post('/maintenance/job-orders/1/accept');
  await conn.query('UPDATE job_orders SET created_at = NOW() - INTERVAL 30 HOUR WHERE id = 1');

  assert.doesNotMatch(await overdueList(plant), /JO-\d{4}-0001/, 'normal target 72h: 30h old is not overdue');
  const res = await mmgr.post('/maintenance/settings', { ...targets, overdue_hours_normal: 24, reason: 'Trial week' });
  assert.equal(res.status, 302);
  assert.match(await overdueList(plant), /JO-\d{4}-0001/, 'normal target 24h: now overdue');
  assert.match((await plant.get('/maintenance/kpi')).text, /4h \/ 24h \/ 24h \/ 168h/);
});

test('each change is recorded once with old value, new value, who and why, and shown in the history', async () => {
  const [rows] = await conn.query("SELECT entity_id, old_value, new_value, reason, user_id FROM audit_log WHERE entity = 'maintenance_setting'");
  const [[m]] = await conn.query("SELECT id FROM users WHERE username = 'mmgr1'");
  assert.deepEqual(rows.map(r => ({ ...r })), [
    { entity_id: 'overdue_hours_normal', old_value: '72', new_value: '24', reason: 'Trial week', user_id: m.id }
  ]);
  const page = (await plant.get('/maintenance/settings')).text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(page, /normal target 72h 24h Maintenance Manager Tester Trial week/i);
  // Saving the same values again records nothing.
  await mmgr.post('/maintenance/settings', { ...targets, overdue_hours_normal: 24 });
  const [[{ c }]] = await conn.query("SELECT COUNT(*) c FROM audit_log WHERE entity = 'maintenance_setting'");
  assert.equal(c, 1);
});

test('invalid targets are refused, nothing is saved, and what was typed stays in the form', async () => {
  const bad = await mmgr.post('/maintenance/settings', { ...targets, overdue_hours_high: '2.5', overdue_hours_low: 'abc' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Nothing was saved/);
  assert.match(bad.text, /value="2\.5"/);
  assert.match(bad.text, /value="abc"/);
  assert.match(bad.text, /aria-invalid="true"/);

  const order = await mmgr.post('/maintenance/settings', { ...targets, overdue_hours_normal: 100, overdue_hours_low: 50 });
  assert.equal(order.status, 400);
  assert.match(order.text, /a lower priority can&#39;t be due sooner|a lower priority can't be due sooner/);
  const [[s]] = await conn.query("SELECT setting_value v FROM maintenance_settings WHERE setting_key = 'overdue_hours_low'");
  assert.equal(s.v, '168');
});

test('read-only viewers see the targets but no way to change them', async () => {
  const html = (await plant.get('/maintenance/settings')).text;
  assert.match(html, /<fieldset class="plain-fieldset" disabled>/);
  assert.doesNotMatch(html, /Save targets/);
  assert.match(html, /Only the Maintenance Manager can change these/);
});

test('if migration 004 is rolled back, the KPI page keeps working on the built-in targets', async () => {
  await migrator.down(conn);
  try {
    const res = await plant.get('/maintenance/kpi');
    assert.equal(res.status, 200);
    assert.match(res.text, /4h \/ 24h \/ 72h \/ 168h/);
  } finally {
    await migrator.up(conn);
  }
});

// ---- Accounts (npm run user) ----
test('adding an account gives the starter password, which must be changed at first login', async () => {
  await users.add(pool, { username: 'jdelacruz', fullName: 'Juan Dela Cruz', role: 'maintenance_manager', department: 'Maintenance' });
  const a = await anonymous(app);
  const res = await a.post('/login', { username: 'jdelacruz', password: 'password123' });
  assert.equal(res.headers.location, '/account/change-password');
  await assert.rejects(users.add(pool, { username: 'jdelacruz', fullName: 'Again', role: 'production' }), /already exists/);
  await assert.rejects(users.add(pool, { username: 'x y', fullName: 'Bad', role: 'production' }), /Username must be/);
  await assert.rejects(users.add(pool, { username: 'newperson', fullName: 'Bad Role', role: 'supervisor' }), /Unknown role "supervisor"/);
});

test('role changes, deactivation and password resets are audited', async () => {
  assert.equal(await users.setRole(pool, 'jdelacruz', 'plant_manager', 'Promoted'), true);
  assert.equal(await users.setRole(pool, 'jdelacruz', 'plant_manager'), false, 'no change, no audit row');
  await users.setActive(pool, 'jdelacruz', false, 'Left the company');
  await users.resetPassword(pool, 'prod1', 'Forgot password');
  const [rows] = await conn.query("SELECT entity_id, action, old_value, new_value, reason, source FROM audit_log WHERE entity = 'user' ORDER BY id");
  assert.deepEqual(rows.map(r => [r.entity_id, r.action, r.old_value, r.new_value, r.reason, r.source]), [
    ['jdelacruz', 'create', null, 'maintenance_manager', null, 'cli'],
    ['jdelacruz', 'role_change', 'maintenance_manager', 'plant_manager', 'Promoted', 'cli'],
    ['jdelacruz', 'deactivate', '1', '0', 'Left the company', 'cli'],
    ['prod1', 'password_reset', null, null, 'Forgot password', 'cli']
  ]);
  const [[p]] = await conn.query("SELECT password_hash h FROM users WHERE username = 'prod1'");
  assert.equal(await bcrypt.compare('password123', p.h), true);
});

test('the npm run user command works end to end', () => {
  const env = { ...process.env, DB_NAME: TEST_DB };
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'user.js'), ...args], { env, encoding: 'utf8' });
  const add = run('add', 'msantos', 'Maria Santos', 'maintenance', 'Maintenance');
  assert.equal(add.status, 0, add.stderr);
  assert.match(add.stdout, /Created msantos \(Maintenance Technician\)/);
  const list = run('list');
  assert.match(list.stdout, /msantos\s+Maintenance Technician\s+Maria Santos · Maintenance/);
  assert.match(list.stdout, /\[off\] jdelacruz/);
  const bad = run('role', 'msantos', 'boss');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown role "boss"/);
  assert.match(run('help').stdout, /Usage:/);
});
