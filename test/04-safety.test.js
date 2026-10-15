// Phase 2 safety fixes: crash-proof errors (I-2), job completion guard (I-4),
// CSRF + cookie flags (I-5), login limiter (I-10), starter password (I-3).
const { resetDb, db } = require('./helpers/setup');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const request = require('supertest');
const app = require('../src/app');
const limiter = require('../src/middleware/loginLimiter');
const { anonymous, login } = require('./helpers/agent');

let conn;
before(async () => { await resetDb(); conn = await db(); });
after(async () => { await conn.end(); await require('../src/config/db').end(); });

// ---- I-2: a database error shows an error page and the server keeps going
test('a failing query returns a 500 page without SQL details, and the app keeps serving', async () => {
  const prod = await login(app, 'prod1');
  await conn.query('RENAME TABLE machines TO machines_hidden');
  try {
    const res = await prod.get('/production/machines');
    assert.equal(res.status, 500);
    assert.match(res.text, /could not complete that request/);
    // No SQL, driver error codes, table names or stack frames leak to the page.
    assert.doesNotMatch(res.text, /SELECT |ER_[A-Z_]+|machines_hidden|doesn't exist|\bat \S+\.js:\d+/);
  } finally {
    await conn.query('RENAME TABLE machines_hidden TO machines');
  }
  assert.equal((await prod.get('/production/machines')).status, 200);
  assert.equal((await request(app).get('/login')).status, 200);
});

// ---- I-5: CSRF
test('a POST without the CSRF token is refused and changes nothing', async () => {
  const prod = await login(app, 'prod1');
  const res = await prod.rawPost('/production/job-orders').type('form')
    .send({ machine_name: 'IM-01', problem_desc: 'forged', priority: 'urgent' });
  assert.equal(res.status, 403);
  const [[{ n }]] = await conn.query("SELECT COUNT(*) n FROM job_orders WHERE problem_desc = 'forged'");
  assert.equal(n, 0);
});

test('a POST with a wrong CSRF token is refused', async () => {
  const prod = await login(app, 'prod1');
  const res = await prod.rawPost('/production/operators').type('form').send({ _csrf: 'x'.repeat(48), name: 'Forged' });
  assert.equal(res.status, 403);
});

test('the login form itself is CSRF-protected', async () => {
  const res = await request(app).post('/login').type('form').send({ username: 'prod1', password: 'Test-pass-123' });
  assert.equal(res.status, 403);
});

test('every POST form on rendered pages carries the token', async () => {
  const prod = await login(app, 'prod1');
  for (const url of ['/production/floor', '/production/machines', '/production/job-orders/new', '/account/change-password']) {
    const html = (await prod.get(url)).text;
    const forms = html.match(/<form\b[^>]*method="POST"[^>]*>/gi) || [];
    const tokens = html.match(/name="_csrf"/g) || [];
    assert.ok(forms.length > 0, url);
    assert.equal(tokens.length, forms.length, url);
  }
});

test('session cookie is HttpOnly + SameSite=Lax, and a new session id is issued at login', async () => {
  const anon = request.agent(app);
  const first = await anon.get('/login');
  const before = (first.headers['set-cookie'] || [''])[0];
  assert.match(before, /HttpOnly/);
  assert.match(before, /SameSite=Lax/);
  const token = /name="_csrf" value="([^"]+)"/.exec(first.text)[1];
  const res = await anon.post('/login').type('form').send({ _csrf: token, username: 'prod1', password: 'Test-pass-123' });
  const after = (res.headers['set-cookie'] || [''])[0];
  assert.ok(after, 'login sets a fresh cookie');
  assert.notEqual(after.split(';')[0], before.split(';')[0]);
});

test('basic security headers are sent', async () => {
  const res = await request(app).get('/login');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
  assert.equal(res.headers['x-powered-by'], undefined);
});

// ---- I-4: completion guard
test('only the accepting technician can complete or add requests, and only while open', async () => {
  const prod = await login(app, 'prod1');
  const m1 = await login(app, 'maint1');
  const m2 = await login(app, 'maint2');
  await prod.post('/production/job-orders', { machine_name: 'IM-01', problem_desc: 'Guard test', priority: 'normal' });
  const [[jo]] = await conn.query("SELECT id FROM job_orders WHERE problem_desc = 'Guard test'");
  const status = async () => (await conn.query('SELECT status FROM job_orders WHERE id = ?', [jo.id]))[0][0].status;

  // Not yet accepted: nobody can complete it.
  assert.equal((await m1.post(`/maintenance/job-orders/${jo.id}/complete`)).status, 403);
  assert.equal(await status(), 'pending');

  await m1.post(`/maintenance/job-orders/${jo.id}/accept`);
  // Another technician cannot complete it or add requests to it.
  assert.equal((await m2.post(`/maintenance/job-orders/${jo.id}/complete`)).status, 403);
  assert.equal((await m2.post(`/maintenance/job-orders/${jo.id}/materials`, { item_name: 'x', quantity: 1, unit: 'pcs' })).status, 403);
  assert.equal(await status(), 'accepted');

  // The accepting technician can.
  assert.equal((await m1.post(`/maintenance/job-orders/${jo.id}/complete`)).status, 302);
  assert.equal(await status(), 'completed');

  // A completed job can't be completed again or get new requests.
  assert.equal((await m1.post(`/maintenance/job-orders/${jo.id}/materials`, { item_name: 'x', quantity: 1, unit: 'pcs' })).status, 403);
  const [[{ n }]] = await conn.query("SELECT COUNT(*) n FROM job_order_status_log WHERE job_order_id = ? AND status = 'completed'", [jo.id]);
  assert.equal(n, 1);
});

test('a cancelled job cannot be completed', async () => {
  const prod = await login(app, 'prod1');
  const m1 = await login(app, 'maint1');
  await prod.post('/production/job-orders', { machine_name: 'IM-02', problem_desc: 'Cancel test', priority: 'low' });
  const [[jo]] = await conn.query("SELECT id FROM job_orders WHERE problem_desc = 'Cancel test'");
  await prod.post(`/production/job-orders/${jo.id}/cancel`);
  assert.equal((await m1.post(`/maintenance/job-orders/${jo.id}/complete`)).status, 403);
  const [[row]] = await conn.query('SELECT status FROM job_orders WHERE id = ?', [jo.id]);
  assert.equal(row.status, 'cancelled');
});

// ---- I-10: login limiter
test('5 wrong passwords lock that username for 15 minutes; others are unaffected', async () => {
  limiter._reset();
  const a = await anonymous(app);
  for (let i = 0; i < 5; i++) {
    const r = await a.post('/login', { username: 'tool1', password: 'wrong' });
    assert.match(r.text, /Incorrect username or password/);
  }
  const locked = await a.post('/login', { username: 'tool1', password: 'Test-pass-123' });
  assert.equal(locked.status, 429);
  assert.match(locked.text, /Too many failed attempts/);
  assert.match(locked.text, /value="tool1"/); // typed username is kept
  const other = await a.post('/login', { username: 'purch1', password: 'Test-pass-123' });
  assert.equal(other.status, 302);
  limiter._reset();
});

// ---- I-3: starter password
test('a user on the starter password must choose a new one before anything else', async () => {
  const hash = await bcrypt.hash('password123', 4);
  await conn.query("INSERT INTO users (username, password_hash, full_name, role) VALUES ('newhire', ?, 'New Hire', 'production')", [hash]);
  const a = await anonymous(app);
  const res = await a.post('/login', { username: 'newhire', password: 'password123' });
  assert.equal(res.headers.location, '/account/change-password');

  const page = await a.get('/account/change-password');
  a.csrf = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
  assert.match(page.text, /still using the starter password/);
  assert.equal((await a.get('/production/dashboard')).headers.location, '/account/change-password');
  assert.equal((await a.post('/production/operators', { name: 'Sneaky' })).status, 403);

  const reuse = await a.post('/account/change-password', { current_password: 'password123', new_password: 'password123', confirm_password: 'password123' });
  assert.match(reuse.text, /starter password everyone was given/);

  const ok = await a.post('/account/change-password', { current_password: 'password123', new_password: 'Line1-Mixer', confirm_password: 'Line1-Mixer' });
  assert.match(ok.text, /Password updated/);
  assert.equal((await a.get('/production/dashboard')).status, 200);
});
