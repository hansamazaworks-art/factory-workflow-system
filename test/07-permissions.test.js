// Phase 3: role-based access, enforced on the server for every route.
const { resetDb, db } = require('./helpers/setup');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const { login } = require('./helpers/agent');
const { CAPABILITIES, ROLES, can } = require('../src/constants/permissions');
const { ROLE_HOME } = require('../src/constants/auth');

let conn;
const agents = {};
const USERS = ['prod1', 'maint1', 'maint2', 'tool1', 'purch1', 'boss1', 'mmgr1', 'plant1', 'admin1'];
before(async () => {
  await resetDb();
  conn = await db();
  for (const u of USERS) agents[u] = await login(app, u);
});
after(async () => { await conn.end(); await require('../src/config/db').end(); });

// Who may do each thing (approved matrix, Phase 1 section F). Requests use
// ids or bodies that can't change data, so an allowed request answers
// 200/302/400/404 and a refused one answers 403.
const MATRIX = [
  ['GET', '/maintenance/dashboard', ['maint1', 'maint2', 'boss1', 'mmgr1', 'plant1', 'admin1']],
  ['GET', '/maintenance/kpi', ['maint1', 'maint2', 'boss1', 'mmgr1', 'plant1', 'admin1']],
  ['GET', '/maintenance/pm', ['maint1', 'maint2', 'boss1', 'mmgr1', 'plant1', 'admin1']],
  ['GET', '/maintenance/settings', ['boss1', 'mmgr1', 'plant1', 'admin1']],
  ['POST', '/maintenance/settings', ['mmgr1', 'admin1']],
  ['POST', '/maintenance/pm', ['mmgr1', 'admin1']],
  ['POST', '/maintenance/pm/99999/toggle', ['mmgr1', 'admin1']],
  ['POST', '/maintenance/pm/99999/complete', ['maint1', 'maint2', 'mmgr1', 'admin1']],
  ['POST', '/maintenance/pm/99999/skip', ['maint1', 'maint2', 'mmgr1', 'admin1']],
  ['POST', '/maintenance/job-orders/99999/accept', ['maint1', 'maint2', 'mmgr1', 'admin1']],
  ['POST', '/maintenance/job-orders/99999/materials', ['maint1', 'maint2', 'mmgr1', 'admin1']],
  ['POST', '/maintenance/job-orders/99999/complete', ['maint1', 'maint2', 'mmgr1', 'admin1']],
  ['GET', '/production/dashboard', ['prod1', 'admin1']],
  ['GET', '/toolroom/dashboard', ['tool1', 'admin1']],
  ['GET', '/purchasing/dashboard', ['purch1', 'admin1']],
  ['GET', '/management/dashboard', ['boss1', 'admin1']]
];

for (const [method, url, allowed] of MATRIX) {
  test(`${method} ${url}: only ${allowed.join(', ')}`, async () => {
    for (const u of USERS) {
      const res = method === 'GET' ? await agents[u].get(url) : await agents[u].post(url, { quantity: 'x' });
      if (allowed.includes(u)) {
        assert.notEqual(res.status, 403, `${u} should be allowed`);
        assert.ok([200, 302, 400, 404].includes(res.status), `${u} got ${res.status}`);
      } else {
        assert.equal(res.status, 403, `${u} should be refused`);
      }
    }
  });
}

test('refused POSTs changed nothing', async () => {
  const [[pm]] = await conn.query('SELECT COUNT(*) n FROM pm_schedules');
  const [[st]] = await conn.query('SELECT COUNT(*) n FROM audit_log');
  assert.deepEqual([pm.n, st.n], [0, 0]);
});

test('every role has a home page it is allowed to open', async () => {
  for (const role of ROLES) assert.ok(ROLE_HOME[role], `${role} has no home page`);
  assert.equal(agents.mmgr1.home, '/maintenance/dashboard');
  assert.equal(agents.plant1.home, '/maintenance/kpi');
  for (const u of USERS) assert.equal((await agents[u].get(agents[u].home)).status, 200, u);
});

test('every capability names only real roles, and unknown capabilities are refused at startup', () => {
  for (const [cap, roles] of Object.entries(CAPABILITIES)) {
    for (const r of roles) assert.ok(ROLES.includes(r), `${cap}: unknown role ${r}`);
  }
  assert.throws(() => can('maintenance', 'no.such.capability'), /Unknown capability/);
  const { requirePermission } = require('../src/middleware/auth');
  assert.throws(() => requirePermission('typo.capability'), /Unknown capability/);
});

test('pages show actions only to people allowed to take them', async () => {
  await agents.prod1.post('/production/job-orders', { machine_name: 'IM-01', problem_desc: 'View test', priority: 'normal' });
  const has = async (u, url, needle) => (await agents[u].get(url)).text.includes(needle);
  assert.equal(await has('maint1', '/maintenance/job-orders/1', '/accept"'), true);
  assert.equal(await has('plant1', '/maintenance/job-orders/1', '/accept"'), false);
  assert.equal(await has('boss1', '/maintenance/job-orders/1', '/accept"'), false);
  assert.equal(await has('mmgr1', '/maintenance/pm', 'action="/maintenance/pm"'), true);
  assert.equal(await has('maint1', '/maintenance/pm', 'action="/maintenance/pm"'), false);
  assert.equal(await has('mmgr1', '/maintenance/settings', 'Save targets'), true);
  assert.equal(await has('plant1', '/maintenance/settings', 'Save targets'), false);
  assert.equal(await has('maint1', '/maintenance/dashboard', 'href="/maintenance/settings"'), false);
  assert.equal(await has('mmgr1', '/maintenance/dashboard', 'href="/maintenance/settings"'), true);
});

test('a Maintenance Manager can work a job another technician accepted; another technician cannot', async () => {
  await agents.maint1.post('/maintenance/job-orders/1/accept');
  const other = await agents.maint2.post('/maintenance/job-orders/1/materials', { item_name: 'Seal', quantity: 1, unit: 'pcs' });
  assert.equal(other.status, 403);
  const mgr = await agents.mmgr1.post('/maintenance/job-orders/1/materials', { item_name: 'Seal', quantity: 1, unit: 'pcs' });
  assert.equal(mgr.status, 302);
  const [[n]] = await conn.query("SELECT COUNT(*) c FROM material_requests WHERE job_order_id = 1");
  assert.equal(n.c, 1);
});

test('a role change applies on the very next request, without logging out', async () => {
  const a = await login(app, 'maint2');
  assert.equal((await a.get('/maintenance/settings')).status, 403);
  await conn.query("UPDATE users SET role = 'maintenance_manager' WHERE username = 'maint2'");
  assert.equal((await a.get('/maintenance/settings')).status, 200);
  await conn.query("UPDATE users SET role = 'production' WHERE username = 'maint2'");
  assert.equal((await a.get('/maintenance/dashboard')).status, 403);
  assert.equal((await a.get('/production/dashboard')).status, 200);
  await conn.query("UPDATE users SET role = 'maintenance' WHERE username = 'maint2'");
});

test('a deactivated user is signed out on their next click, and a POST is refused', async () => {
  const a = await login(app, 'tool1');
  const b = await login(app, 'tool1');
  await conn.query("UPDATE users SET is_active = 0 WHERE username = 'tool1'");
  const page = await a.get('/toolroom/dashboard');
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, '/login?ended=1');
  assert.match((await a.get('/login?ended=1')).text, /Your session ended/);
  const post = await b.post('/toolroom/inventory', { item_name: 'Should not save', unit: 'pcs' });
  assert.equal(post.status, 401);
  const [[n]] = await conn.query("SELECT COUNT(*) c FROM inventory WHERE item_name = 'Should not save'");
  assert.equal(n.c, 0);
  await conn.query("UPDATE users SET is_active = 1 WHERE username = 'tool1'");
});
