// Phase 3 (K-4): one company time zone; calendar dates never shift.
// Each scenario below reproduced a real bug on the original code with the
// host clock on Philippine time (see the Phase 3 report).
const { resetDb, db } = require('./helpers/setup');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const pool = require('../src/config/db');
const dates = require('../src/utils/dates');
const { utcOffset, TIMEZONE } = require('../src/config/timezone');
const { login } = require('./helpers/agent');

let conn, prod, maint, mmgr;
before(async () => {
  await resetDb();
  conn = await db();
  [prod, maint, mmgr] = await Promise.all(['prod1', 'maint1', 'mmgr1'].map(u => login(app, u)));
});
after(async () => { await conn.end(); await pool.end(); });
const text = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('"today" is the Philippine date, including before 08:00 when UTC is still yesterday', () => {
  assert.equal(TIMEZONE, 'Asia/Manila');
  assert.equal(dates.today(new Date('2026-10-10T15:59:59Z')), '2026-10-10');  // 23:59 in Manila
  assert.equal(dates.today(new Date('2026-10-10T16:00:00Z')), '2026-10-11');  // 00:00 in Manila
  assert.equal(dates.today(new Date('2026-10-10T23:30:00Z')), '2026-10-11');  // 07:30 in Manila
});

test('calendar arithmetic handles month ends and leap years', () => {
  assert.equal(dates.addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(dates.addDays('2026-01-31', 30), '2026-03-02');
  assert.equal(dates.addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(dates.addDays('2027-02-28', 1), '2027-03-01');
  assert.equal(dates.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(dates.addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(dates.isYmd('2028-02-29'), true);
  assert.equal(dates.isYmd('2027-02-29'), false);
  assert.equal(dates.isYmd('2026-02-30'), false);
  assert.equal(dates.isYmd('10/10/2026'), false);
  assert.equal(dates.weekdayShort('2026-10-10'), 'Sat');
});

test('a DATE read from the database prints as the same calendar day', async () => {
  const [[r]] = await pool.query("SELECT DATE('2026-09-01') AS d");
  assert.equal(dates.ymd(r.d), '2026-09-01');
  assert.equal(dates.ymd('2026-09-01'), '2026-09-01');
  assert.equal(dates.ymd(null), '');
});

test('every database connection runs on the company UTC offset', async () => {
  assert.equal(utcOffset(), '+08:00');
  const [[r]] = await pool.query('SELECT @@session.time_zone AS tz, CURDATE() + 0 AS d');
  assert.equal(r.tz, '+08:00');
  assert.equal(String(r.d).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'), dates.today());
});

test('PM due dates no longer drift a day early (original code: first due 1 Sep showed as 31 Aug, next due 9 Oct)', async () => {
  await mmgr.post('/maintenance/pm', { machine_id: 1, task_name: 'Fix bolts', frequency_days: 30, start_date: '2026-09-01' });
  assert.match(text((await maint.get('/maintenance/pm')).text), /Fix bolts 30d 2026-09-01/);

  await maint.post('/maintenance/pm/1/complete', { completed_date: '2026-09-10' });
  const [[s]] = await conn.query("SELECT DATE_FORMAT(next_due_date,'%Y-%m-%d') d, DATE_FORMAT(last_done_date,'%Y-%m-%d') l FROM pm_schedules WHERE id = 1");
  const [[c]] = await conn.query("SELECT DATE_FORMAT(due_date,'%Y-%m-%d') due, DATE_FORMAT(completed_date,'%Y-%m-%d') done FROM pm_completions WHERE pm_schedule_id = 1");
  assert.deepEqual({ ...s }, { d: '2026-10-10', l: '2026-09-10' });
  assert.deepEqual({ ...c }, { due: '2026-09-01', done: '2026-09-10' });

  const detail = text((await maint.get('/maintenance/pm/1')).text);
  assert.match(detail, /Next Due 2026-10-10/);
  assert.match(detail, /Last Done 2026-09-10/);
  assert.match(detail, /2026-09-01 2026-09-10 done/);
});

test('PM completion dates are checked: no future dates, no impossible dates, nothing on a paused schedule', async () => {
  const future = await maint.post('/maintenance/pm/1/complete', { completed_date: dates.addDays(dates.today(), 1) });
  assert.equal(future.status, 400);
  const impossible = await maint.post('/maintenance/pm/1/complete', { completed_date: '2026-02-30' });
  assert.equal(impossible.status, 400);
  await mmgr.post('/maintenance/pm/1/toggle');
  const paused = await maint.post('/maintenance/pm/1/skip', {});
  assert.equal(paused.status, 409);
  await mmgr.post('/maintenance/pm/1/toggle');
  const [[{ n }]] = await conn.query('SELECT COUNT(*) n FROM pm_completions');
  assert.equal(n, 1);
});

test("Analytics puts today's output on today's bar (original code: on yesterday's)", async () => {
  await conn.query("INSERT INTO mold_assignments (machine_id, mold_id, cavities_snapshot, assigned_by) VALUES (1, 1, 8, 1)");
  await conn.query(
    `INSERT INTO production_entries (entry_date, shift_id, machine_id, assignment_id, mold_id, operator_id, start_time, end_time, machine_opens, cavities_snapshot, created_by)
     VALUES (?, 1, 1, 1, 1, 1, '07:00', '15:00', 100, 8, 1)`, [dates.today()]);
  const html = (await prod.get('/production/analytics')).text;
  const bars = [...html.matchAll(/bar-value">([^<]*)<[\s\S]*?bar-label">([^<]*)</g)].map(m => [m[2].trim(), m[1].trim()]);
  assert.equal(bars.length, 7);
  assert.deepEqual(bars[6], [dates.weekdayShort(dates.today()), '800']);
  assert.ok(bars.slice(0, 6).every(([, v]) => v === '0'), JSON.stringify(bars));
});

test("Reports and the Downtime form default to today's date", async () => {
  const rep = (await prod.get('/production/reports')).text;
  assert.match(rep, new RegExp(`name="to"[^>]*value="${dates.today()}"|value="${dates.today()}"[^>]*name="to"`));
  assert.match(rep, new RegExp(`value="${dates.addDays(dates.today(), -6)}"`));
  assert.match(text(rep), /Injection Molder #1 \(IM-01\) 1 800/);
  const dt = (await prod.get('/production/downtime')).text;
  assert.match(dt, new RegExp(`value="${dates.today()}"`));
});

test("the KPI chart counts a job completed today on today's bar", async () => {
  await prod.post('/production/job-orders', { machine_name: 'IM-01', problem_desc: 'KPI day', priority: 'normal' });
  await maint.post('/maintenance/job-orders/1/accept');
  await maint.post('/maintenance/job-orders/1/complete');
  const html = (await mmgr.get('/maintenance/kpi')).text;
  const bars = [...html.matchAll(/bar-value">([^<]*)<[\s\S]*?bar-label">([^<]*)</g)].map(m => [m[2].trim(), m[1].trim()]);
  assert.deepEqual(bars[6], [dates.weekdayShort(dates.today()), '1']);
});
