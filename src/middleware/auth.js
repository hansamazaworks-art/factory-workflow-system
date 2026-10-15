const pool = require('../config/db');
const { can, assertKnown } = require('../constants/permissions');

// Blocks a page unless someone is logged in.
function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

function deny(req, res) {
  return res.status(403).render('error', {
    message: "You don't have access to that page.",
    user: req.session.user
  });
}

// Blocks a request unless the user holds at least one of the named
// capabilities (see src/constants/permissions.js). Checked on the server
// for every request: hiding a button is never the only protection.
// Usage: requirePermission('pm.manage')
function requirePermission(...capabilities) {
  capabilities.forEach(assertKnown);
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!capabilities.some(c => can(req.session.user.role, c))) return deny(req, res);
    next();
  };
}

// Older role-name check, kept for compatibility. New code uses
// requirePermission so the matrix stays in one file.
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/login');
    if (!allowedRoles.includes(req.session.user.role)) return deny(req, res);
    next();
  };
}

// Re-reads the logged-in user from the database on every request, so a
// role change or deactivation takes effect immediately rather than when
// the 8-hour session runs out.
async function refreshSessionUser(req, res, next) {
  if (!req.session.user) return next();
  try {
    const [rows] = await pool.query(
      'SELECT id, username, full_name, role, department, is_active FROM users WHERE id = ?',
      [req.session.user.id]);
    const u = rows[0];
    if (!u || !u.is_active) {
      return req.session.destroy(() => {
        if (req.method === 'GET') return res.redirect('/login?ended=1');
        res.status(401).render('error', { message: 'Your session has ended. Log in again.', user: null });
      });
    }
    req.session.user = { id: u.id, username: u.username, full_name: u.full_name, role: u.role, department: u.department };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireLogin, requirePermission, requireRole, refreshSessionUser };
