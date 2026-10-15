// Test bootstrap. Require this FIRST in every test file: it points the app
// at a throwaway database before the connection pool is created.
//
// Safety: the database is dropped and rebuilt for every test file, so the
// name MUST end in "_test". Your real factory_system database is never used.
//
// Settings (environment variables, all optional):
//   TEST_DB_NAME      default factory_system_test
//   TEST_DB_HOST/USER/PASSWORD   default to DB_HOST/DB_USER/DB_PASSWORD from .env
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const TEST_DB = process.env.TEST_DB_NAME || 'factory_system_test';
if (!/_test$/.test(TEST_DB)) {
  throw new Error(`Refusing to run: test database "${TEST_DB}" must end in _test.`);
}
process.env.DB_NAME = TEST_DB;
if (process.env.TEST_DB_HOST) process.env.DB_HOST = process.env.TEST_DB_HOST;
if (process.env.TEST_DB_USER) process.env.DB_USER = process.env.TEST_DB_USER;
if (process.env.TEST_DB_PASSWORD !== undefined) process.env.DB_PASSWORD = process.env.TEST_DB_PASSWORD;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.AUTO_APPROVE_LIMIT = '5000';
const { utcOffset } = require('../../src/config/timezone'); // company time zone, as the app runs
const migrator = require('../../src/db/migrator');

const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const PASSWORD = 'Test-pass-123';
const USERS = [
  ['prod1', 'Production Tester', 'production', 'Production'],
  ['maint1', 'Maintenance Tester', 'maintenance', 'Maintenance'],
  ['maint2', 'Second Technician', 'maintenance', 'Maintenance'],
  ['tool1', 'Toolroom Tester', 'toolroom', 'Toolroom'],
  ['purch1', 'Purchasing Tester', 'purchasing', 'Purchasing'],
  ['boss1', 'Management Tester', 'management', 'Management'],
  ['mmgr1', 'Maintenance Manager Tester', 'maintenance_manager', 'Maintenance'],
  ['plant1', 'Plant Manager Tester', 'plant_manager', 'Plant'],
  ['admin1', 'Administrator Tester', 'admin', 'IT']
];

// Rebuild the test database from db/schema.sql + a small fixture.
async function resetDb() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
    multipleStatements: true
  });
  const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'schema.sql'), 'utf8')
    .replace(/CREATE DATABASE IF NOT EXISTS factory_system;/, '')
    .replace(/USE factory_system;/, '');
  await conn.query(`DROP DATABASE IF EXISTS \`${TEST_DB}\`; CREATE DATABASE \`${TEST_DB}\`; USE \`${TEST_DB}\`;`);
  await conn.query(schema);
  await conn.query('SET time_zone = ?', [utcOffset()]);
  await migrator.up(conn); // bring the fresh schema up to date, exactly as npm run migrate does

  const hash = await bcrypt.hash(PASSWORD, 4);
  for (const [u, name, role, dept] of USERS) {
    await conn.query('INSERT INTO users (username, password_hash, full_name, role, department) VALUES (?,?,?,?,?)',
      [u, hash, name, role, dept]);
  }
  await conn.query(`INSERT INTO shifts (name, start_time, end_time, is_overnight) VALUES
    ('Day Shift','07:00:00','19:00:00',0), ('Night Shift','19:00:00','07:00:00',1)`);
  await conn.query(`INSERT INTO machines (code, name, location) VALUES
    ('IM-01','Injection Molder #1','Line 1'), ('IM-02','Injection Molder #2','Line 1')`);
  await conn.query(`INSERT INTO molds (code, name, product, cavities, standard_cycle_sec) VALUES
    ('MLD-100','Mold 100','Cap 28mm',8,12.5), ('MLD-200','Mold 200','Lid 500ml',4,18)`);
  await conn.query(`INSERT INTO operators (name) VALUES ('Operator One'), ('Operator Two')`);
  await conn.query(`INSERT INTO inventory (item_name, sku, quantity_on_hand, unit, reorder_level) VALUES
    ('O-ring 20mm','OR-20',10,'pcs',2)`);
  await conn.end();
}

// A second connection for assertions straight against the database.
async function db() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: TEST_DB
  });
  await conn.query('SET time_zone = ?', [utcOffset()]);
  return conn;
}

module.exports = { resetDb, db, PASSWORD, USERS, TEST_DB };
