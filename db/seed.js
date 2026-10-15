// Creates one starter login per role so you can test the system
// immediately after setup. Run with: npm run seed
//
// Safe to re-run - it skips any username that already exists.

const bcrypt = require('bcryptjs');
const pool = require('../src/config/db');

const { SEED_PASSWORD: DEFAULT_PASSWORD } = require('../src/constants/auth'); // users must change it at first login

const accounts = [
  { username: 'prod1',  full_name: 'Production User',  role: 'production',  department: 'Production Line 1' },
  { username: 'maint1', full_name: 'Maintenance User', role: 'maintenance', department: 'Maintenance' },
  { username: 'tool1',  full_name: 'Toolroom User',    role: 'toolroom',    department: 'Toolroom' },
  { username: 'purch1', full_name: 'Purchasing User',  role: 'purchasing',  department: 'Purchasing' },
  { username: 'boss1',  full_name: 'Management User',  role: 'management',  department: 'Management' },
  { username: 'mmgr1',  full_name: 'Maintenance Manager (test)', role: 'maintenance_manager', department: 'Maintenance' },
  { username: 'plant1', full_name: 'Plant Manager (test)',       role: 'plant_manager',       department: 'Plant' }
];

async function seed() {
  const hash = await bcrypt.hash(DEFAULT_PASSWORD, 10);

  for (const acc of accounts) {
    const [existing] = await pool.query('SELECT id FROM users WHERE username = ?', [acc.username]);
    if (existing.length > 0) {
      console.log(`- ${acc.username} already exists, skipping`);
      continue;
    }
    await pool.query(
      'INSERT INTO users (username, password_hash, full_name, role, department) VALUES (?, ?, ?, ?, ?)',
      [acc.username, hash, acc.full_name, acc.role, acc.department]
    );
    console.log(`+ created ${acc.username} (${acc.role})`);
  }

  await seedFloorControl();

  console.log('\nAll seeded accounts use this password:', DEFAULT_PASSWORD);
  console.log('Change these before real use.');
  process.exit(0);
}

// Starter data for Floor Control so the module isn't empty on first
// login. Safe to re-run - each insert checks for an existing code/name.
async function seedFloorControl() {
  const shifts = [
    { name: 'Day Shift',   start_time: '07:00:00', end_time: '19:00:00', is_overnight: 0 },
    { name: 'Night Shift', start_time: '19:00:00', end_time: '07:00:00', is_overnight: 1 }
  ];
  for (const s of shifts) {
    const [existing] = await pool.query('SELECT id FROM shifts WHERE name = ?', [s.name]);
    if (existing.length > 0) continue;
    await pool.query('INSERT INTO shifts (name, start_time, end_time, is_overnight) VALUES (?, ?, ?, ?)',
      [s.name, s.start_time, s.end_time, s.is_overnight]);
    console.log(`+ created shift ${s.name}`);
  }

  const machines = [
    { code: 'IM-01', name: 'Injection Molder #1', location: 'Building B, Line 1' },
    { code: 'IM-02', name: 'Injection Molder #2', location: 'Building B, Line 1' },
    { code: 'IM-03', name: 'Injection Molder #3', location: 'Building B, Line 2' }
  ];
  for (const m of machines) {
    const [existing] = await pool.query('SELECT id FROM machines WHERE code = ?', [m.code]);
    if (existing.length > 0) continue;
    await pool.query('INSERT INTO machines (code, name, location, status) VALUES (?, ?, ?, ?)',
      [m.code, m.name, m.location, 'idle']);
    console.log(`+ created machine ${m.code}`);
  }

  const molds = [
    { code: 'MLD-100', name: 'Mold 100', product: 'Bottle Cap 28mm', cavities: 8, standard_cycle_sec: 12.5 },
    { code: 'MLD-200', name: 'Mold 200', product: 'Container Lid 500ml', cavities: 4, standard_cycle_sec: 18.0 }
  ];
  for (const m of molds) {
    const [existing] = await pool.query('SELECT id FROM molds WHERE code = ?', [m.code]);
    if (existing.length > 0) continue;
    await pool.query('INSERT INTO molds (code, name, product, cavities, standard_cycle_sec) VALUES (?, ?, ?, ?, ?)',
      [m.code, m.name, m.product, m.cavities, m.standard_cycle_sec]);
    console.log(`+ created mold ${m.code}`);
  }

  const operators = ['Juan Dela Cruz', 'Maria Santos', 'Pedro Reyes'];
  for (const name of operators) {
    const [existing] = await pool.query('SELECT id FROM operators WHERE name = ?', [name]);
    if (existing.length > 0) continue;
    await pool.query('INSERT INTO operators (name) VALUES (?)', [name]);
    console.log(`+ created operator ${name}`);
  }
}

seed().catch(err => {
  console.error('Seeding failed:', err.message);
  process.exit(1);
});
