const express = require('express');
const bcrypt = require('bcryptjs');
const router = require('../utils/asyncRouter')(); // catches async errors (see utils/asyncRouter.js)
const pool = require('../config/db');
const limiter = require('../middleware/loginLimiter');
const { SEED_PASSWORD, ROLE_HOME } = require('../constants/auth');

router.get('/login', (req, res) => {
  if (req.session.user) {
    return res.redirect(ROLE_HOME[req.session.user.role] || '/');
  }
  res.render('auth/login', {
    error: null, username: '',
    notice: req.query.ended ? 'Your session ended because your account was changed or switched off. Log in again, or ask the administrator.' : null
  });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.render('auth/login', { error: 'Enter your username and password.', username });
  }

  const lockedMinutes = limiter.lockedFor(req, username);
  if (lockedMinutes > 0) {
    return res.status(429).render('auth/login', {
      username,
      error: `Too many failed attempts. Try again in ${lockedMinutes} minute${lockedMinutes === 1 ? '' : 's'}, or ask an administrator.`
    });
  }

  const [rows] = await pool.query(
    'SELECT * FROM users WHERE username = ? AND is_active = 1',
    [username]
  );

  const user = rows[0];
  const match = user ? await bcrypt.compare(password, user.password_hash) : false;

  if (!match) {
    limiter.recordFailure(req, username);
    return res.render('auth/login', { error: 'Incorrect username or password.', username });
  }
  limiter.clear(req, username);

  // New session id at login, so a session id planted before login is useless.
  await new Promise((resolve, reject) => req.session.regenerate(err => (err ? reject(err) : resolve())));

  req.session.user = {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    role: user.role,
    department: user.department
  };

  // Still on the starter password: must choose a new one before anything else.
  if (password === SEED_PASSWORD) {
    req.session.mustChangePassword = true;
    return res.redirect('/account/change-password');
  }

  res.redirect(ROLE_HOME[user.role] || '/');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

module.exports = router;
