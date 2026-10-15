// Phase 3: migration runner, rollback, and append-only history.
const { resetDb, db, TEST_DB } = require('./helpers/setup');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const migrator = require('../src/db/migrator');

let conn;
before(async () => { await resetDb(); conn = await db(); });
after(async () => { await conn.end(); await require('../src/config/db').end(); });

const applied = async () => (await migrator.status(conn)).migrations.filter(m => m.applied).map(m => m.version);

test('the SQL splitter ignores semicolons in quotes and comments', () => {
  const s = migrator.splitSql(`-- a comment; with a semicolon
    INSERT INTO t VALUES ('a;b', "c;d", 'it''s');  /* block; comment */
    # hash comment;
    SELECT \`odd;name\` FROM t;
    SELECT 1`);
  assert.deepEqual(s.map(x => x.replace(/\s+/g, ' ')), [
    `INSERT INTO t VALUES ('a;b', "c;d", 'it''s')`, 'SELECT `odd;name` FROM t', 'SELECT 1'
  ]);
});

test('a fresh database ends up with every migration applied, in order', async () => {
  const files = migrator.listMigrations().map(m => m.version);
  assert.deepEqual(files.slice(0, 4), ['001', '002', '003', '004']);
  assert.deepEqual(await applied(), files);
  assert.deepEqual(await migrator.up(conn), [], 'running again does nothing');
});

test('rolling back 004 and 003 and re-applying them round-trips cleanly, keeping existing rows', async () => {
  await conn.query("INSERT INTO users (username, password_hash, full_name, role) VALUES ('rt', 'x', 'Round Trip', 'production')");
  const [[u]] = await conn.query("SELECT id FROM users WHERE username = 'rt'");
  await conn.query("INSERT INTO job_orders (jo_number, requested_by, machine_name, problem_desc) VALUES ('JO-RT-1', ?, 'IM-01', 'kept')", [u.id]);
  await conn.query("INSERT INTO job_order_status_log (job_order_id, status, changed_by, remarks) SELECT id, 'pending', ?, 'kept' FROM job_orders WHERE jo_number = 'JO-RT-1'", [u.id]);

  // Rolling back 003 needs nobody on the new roles (see the next test).
  const [onNewRoles] = await conn.query("SELECT id, role FROM users WHERE role IN ('plant_manager', 'maintenance_manager')");
  await conn.query("UPDATE users SET role = 'production' WHERE role IN ('plant_manager', 'maintenance_manager')");
  assert.equal(await migrator.down(conn), '004');
  assert.equal(await migrator.down(conn), '003');
  assert.deepEqual(await applied(), ['001', '002']);
  const [[t]] = await conn.query("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = ? AND table_name IN ('audit_log','maintenance_settings')", [TEST_DB]);
  assert.equal(t.n, 0);

  assert.deepEqual(await migrator.up(conn), ['003', '004']);
  for (const u of onNewRoles) await conn.query('UPDATE users SET role = ? WHERE id = ?', [u.role, u.id]);
  const [[row]] = await conn.query("SELECT l.remarks, l.from_status FROM job_order_status_log l JOIN job_orders j ON j.id = l.job_order_id WHERE j.jo_number = 'JO-RT-1'");
  assert.equal(row.remarks, 'kept');
  assert.equal(row.from_status, null);
  const [[s]] = await conn.query("SELECT setting_value v FROM maintenance_settings WHERE setting_key = 'overdue_hours_urgent'");
  assert.equal(s.v, '4');
});

test('rolling back 003 is refused while a user holds a new role, and nothing is undone', async () => {
  await migrator.down(conn); // 004
  await conn.query("UPDATE users SET role = 'maintenance_manager' WHERE username = 'rt'");
  await assert.rejects(migrator.down(conn), /003_roles_and_audit\.down\.sql, statement 1 of 7 failed/);
  assert.deepEqual(await applied(), ['001', '002', '003']);
  const [[t]] = await conn.query("SELECT COUNT(*) n FROM information_schema.triggers WHERE trigger_schema = ?", [TEST_DB]);
  assert.equal(t.n, 4, 'append-only triggers still in place');
  await migrator.up(conn);
});

test('history tables are append-only in the database itself', async () => {
  await assert.rejects(conn.query("UPDATE job_order_status_log SET remarks = 'tampered'"), /append-only/);
  await assert.rejects(conn.query('DELETE FROM job_order_status_log'), /append-only/);
  await conn.query("INSERT INTO audit_log (entity, entity_id, action, source) VALUES ('test', '1', 'create', 'cli')");
  await assert.rejects(conn.query("UPDATE audit_log SET reason = 'x'"), /append-only/);
  await assert.rejects(conn.query('DELETE FROM audit_log'), /append-only/);
});

test('USE lines are skipped, so a migration can never switch to another database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  fs.writeFileSync(path.join(dir, '001_probe.sql'), 'USE mysql;\nCREATE TABLE IF NOT EXISTS mig_probe (id INT);');
  const local = await db();
  await local.query('CREATE TABLE IF NOT EXISTS schema_migrations_backup LIKE schema_migrations');
  await local.query('INSERT INTO schema_migrations_backup SELECT * FROM schema_migrations');
  await local.query('DELETE FROM schema_migrations');
  try {
    await migrator.up(local, { dir });
    const [[here]] = await local.query("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = ? AND table_name = 'mig_probe'", [TEST_DB]);
    const [[there]] = await local.query("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = 'mysql' AND table_name = 'mig_probe'");
    assert.deepEqual([here.n, there.n], [1, 0]);
  } finally {
    await local.query('DELETE FROM schema_migrations');
    await local.query('INSERT INTO schema_migrations SELECT * FROM schema_migrations_backup');
    await local.query('DROP TABLE schema_migrations_backup, mig_probe');
    await local.end();
  }
});

test('a failing migration names the file and statement and is not recorded; a missing rollback file is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
  for (const f of ['001_live_floor_board', '002_pm_schedule', '003_roles_and_audit', '004_maintenance_settings']) {
    fs.copyFileSync(path.join(migrator.DIR, `${f}.sql`), path.join(dir, `${f}.sql`));
  }
  fs.writeFileSync(path.join(dir, '005_broken.sql'), 'CREATE TABLE IF NOT EXISTS ok_probe (id INT);\nALTER TABLE no_such_table ADD COLUMN x INT;');
  await assert.rejects(migrator.up(conn, { dir }), /005_broken\.sql, statement 2 of 2 failed: .*no_such_table/);
  const st = await migrator.status(conn, dir);
  assert.equal(st.migrations.find(m => m.version === '005').applied, false);

  fs.writeFileSync(path.join(dir, '005_broken.sql'), 'CREATE TABLE IF NOT EXISTS ok_probe (id INT);');
  assert.deepEqual(await migrator.up(conn, { dir }), ['005']);
  await assert.rejects(migrator.down(conn, { dir }), /005_broken has no \.down\.sql file/);
  await conn.query("DELETE FROM schema_migrations WHERE version = '005'");
  await conn.query('DROP TABLE ok_probe');
});

test('migrating a database without the factory tables explains what to do', async () => {
  const empty = await db();
  await empty.query('CREATE DATABASE IF NOT EXISTS factory_empty_test');
  await empty.query('USE factory_empty_test');
  try {
    await assert.rejects(migrator.up(empty), /Run db\/schema\.sql first/);
  } finally {
    await empty.query('DROP DATABASE factory_empty_test');
    await empty.end();
  }
});
