// Account administration used by scripts/user.js (npm run user).
// Every change is written to audit_log. New accounts and password resets
// get the starter password; the person must choose their own at first login.
const bcrypt = require('bcryptjs');
const audit = require('./audit');
const { ROLES } = require('../constants/permissions');
const { SEED_PASSWORD } = require('../constants/auth');

const USERNAME = /^[a-z0-9._-]{3,50}$/;

class UserError extends Error {}

function checkRole(role) {
  if (!ROLES.includes(role)) throw new UserError(`Unknown role "${role}". Use one of: ${ROLES.join(', ')}`);
}

async function find(db, username) {
  const [rows] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
  if (!rows[0]) throw new UserError(`No user called "${username}".`);
  return rows[0];
}

async function list(db) {
  const [rows] = await db.query('SELECT username, full_name, role, department, is_active FROM users ORDER BY is_active DESC, role, username');
  return rows;
}

async function add(db, { username, fullName, role, department }) {
  username = String(username || '').trim().toLowerCase();
  fullName = String(fullName || '').trim();
  if (!USERNAME.test(username)) throw new UserError('Username must be 3-50 characters: lowercase letters, digits, dot, dash or underscore.');
  if (!fullName) throw new UserError('A full name is required.');
  checkRole(role);
  const [exists] = await db.query('SELECT id FROM users WHERE username = ?', [username]);
  if (exists.length) throw new UserError(`"${username}" already exists.`);
  const hash = await bcrypt.hash(SEED_PASSWORD, 10);
  const [r] = await db.query(
    'INSERT INTO users (username, password_hash, full_name, role, department) VALUES (?, ?, ?, ?, ?)',
    [username, hash, fullName, role, department || null]);
  await audit.record(db, { entity: 'user', entityId: username, action: 'create', field: 'role', newValue: role, source: 'cli' });
  return r.insertId;
}

async function setRole(db, username, role, reason) {
  checkRole(role);
  const u = await find(db, username);
  if (u.role === role) return false;
  await db.query('UPDATE users SET role = ? WHERE id = ?', [role, u.id]);
  await audit.record(db, { entity: 'user', entityId: username, action: 'role_change', field: 'role', oldValue: u.role, newValue: role, reason, source: 'cli' });
  return true;
}

async function setActive(db, username, active, reason) {
  const u = await find(db, username);
  if (!!u.is_active === active) return false;
  await db.query('UPDATE users SET is_active = ? WHERE id = ?', [active ? 1 : 0, u.id]);
  await audit.record(db, { entity: 'user', entityId: username, action: active ? 'activate' : 'deactivate', field: 'is_active', oldValue: u.is_active, newValue: active ? 1 : 0, reason, source: 'cli' });
  return true;
}

async function resetPassword(db, username, reason) {
  const u = await find(db, username);
  const hash = await bcrypt.hash(SEED_PASSWORD, 10);
  await db.query('UPDATE users SET password_hash = ? WHERE id = ?', [hash, u.id]);
  await audit.record(db, { entity: 'user', entityId: username, action: 'password_reset', reason, source: 'cli' });
}

module.exports = { UserError, list, add, setRole, setActive, resetPassword, ROLES };
