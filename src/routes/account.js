const express = require('express');
const router = require('../utils/asyncRouter')(); // catches async errors (see utils/asyncRouter.js)
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const { requireLogin } = require('../middleware/auth');
const { SEED_PASSWORD, MIN_PASSWORD_LENGTH, ROLE_HOME } = require('../constants/auth');

router.use(requireLogin);

function show(req, res, error, success = false) {
  res.status(error ? 400 : 200).render('account/change-password', {
    user: req.session.user,
    active: 'change-password',
    error,
    success,
    forced: !!req.session.mustChangePassword,
    homeUrl: ROLE_HOME[req.session.user.role] || '/'
  });
}

router.get('/change-password', (req, res) => show(req, res, null));

router.post('/change-password', async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;

  if (!current_password || !new_password || !confirm_password) {
    return show(req, res, 'Fill in all three fields.');
  }
  if (new_password.length < MIN_PASSWORD_LENGTH) {
    return show(req, res, `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (new_password === SEED_PASSWORD) {
    return show(req, res, 'That is the starter password everyone was given. Choose your own.');
  }
  if (new_password !== confirm_password) {
    return show(req, res, 'New password and confirmation do not match.');
  }
  if (new_password === current_password) {
    return show(req, res, 'The new password must be different from the current one.');
  }

  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [req.session.user.id]);
  const dbUser = rows[0];

  const match = await bcrypt.compare(current_password, dbUser.password_hash);
  if (!match) {
    return show(req, res, 'Current password is incorrect.');
  }

  const newHash = await bcrypt.hash(new_password, 10);
  await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, req.session.user.id]);

  req.session.mustChangePassword = false;
  show(req, res, null, true);
});

module.exports = router;
