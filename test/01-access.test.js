// Regression: logins, role guards, and every page loads for its own role.
const { resetDb } = require('./helpers/setup');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const { anonymous, login } = require('./helpers/agent');

before(resetDb);
after(() => require('../src/config/db').end());

const HOME = {
  prod1: '/production/dashboard', maint1: '/maintenance/dashboard', tool1: '/toolroom/dashboard',
  purch1: '/purchasing/dashboard', boss1: '/management/dashboard'
};

const PAGES = {
  prod1: ['/production/dashboard', '/production/floor', '/production/machines', '/production/molds',
    '/production/operators', '/production/mold-changes', '/production/downtime',
    '/production/reports?from=2026-01-01&to=2026-12-31', '/production/analytics',
    '/production/job-orders', '/production/job-orders/new', '/account/change-password'],
  maint1: ['/maintenance/dashboard', '/maintenance/kpi', '/maintenance/pm', '/account/change-password'],
  tool1: ['/toolroom/dashboard', '/toolroom/inventory', '/account/change-password'],
  purch1: ['/purchasing/dashboard', '/account/change-password'],
  boss1: ['/management/dashboard', '/account/change-password']
};

for (const [user, home] of Object.entries(HOME)) {
  test(`${user} logs in and lands on ${home}`, async () => {
    const a = await login(app, user);
    assert.equal(a.home, home);
  });
}

test('wrong password is refused with a message, no session', async () => {
  const a = await anonymous(app);
  const res = await a.post('/login', { username: 'prod1', password: 'nope' });
  assert.equal(res.status, 200);
  assert.match(res.text, /Incorrect username or password/);
  const page = await a.get('/production/dashboard');
  assert.equal(page.status, 302);
  assert.equal(page.headers.location, '/login');
});

test('logged-out visitors are sent to the login page', async () => {
  const a = await anonymous(app);
  for (const p of ['/production/dashboard', '/maintenance/dashboard', '/account/change-password']) {
    const res = await a.get(p);
    assert.equal(res.status, 302, p);
    assert.equal(res.headers.location, '/login', p);
  }
});

for (const [user, pages] of Object.entries(PAGES)) {
  test(`every ${user} page loads`, async () => {
    const a = await login(app, user);
    for (const p of pages) {
      const res = await a.get(p);
      assert.equal(res.status, 200, `${user} ${p}`);
    }
  });
}

test('each department is closed to the other roles (server-side 403)', async () => {
  const other = { prod1: '/maintenance/dashboard', maint1: '/production/dashboard',
    tool1: '/purchasing/dashboard', purch1: '/management/dashboard', boss1: '/toolroom/dashboard' };
  for (const [user, page] of Object.entries(other)) {
    const a = await login(app, user);
    const res = await a.get(page);
    assert.equal(res.status, 403, `${user} ${page}`);
  }
});

test('logout ends the session', async () => {
  const a = await login(app, 'prod1');
  const out = await a.post('/logout');
  assert.equal(out.status, 302);
  const res = await a.get('/production/dashboard');
  assert.equal(res.headers.location, '/login');
});

test('unknown pages return 404', async () => {
  const a = await login(app, 'prod1');
  const res = await a.get('/no-such-page');
  assert.equal(res.status, 404);
});
