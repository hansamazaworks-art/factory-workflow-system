// Builds the Express app without starting it, so the test suite can load
// it directly. src/server.js starts it on the network (npm start).
require('dotenv').config();
require('./config/timezone'); // company time zone for every date (see config/timezone.js)
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');

const csrf = require('./middleware/csrf');
const { refreshSessionUser } = require('./middleware/auth');
const { can, ROLE_LABELS } = require('./constants/permissions');
const { ymd } = require('./utils/dates');
const { ROLE_HOME } = require('./constants/auth');

const authRoutes = require('./routes/auth');
const accountRoutes = require('./routes/account');
const productionRoutes = require('./routes/production');
const maintenanceRoutes = require('./routes/maintenance');
const toolroomRoutes = require('./routes/toolroom');
const purchasingRoutes = require('./routes/purchasing');
const managementRoutes = require('./routes/management');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(session({
  name: 'fws.sid',
  secret: process.env.SESSION_SECRET || 'dev_secret_change_me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000, // 8 hour login session
    httpOnly: true,             // page scripts can't read the session cookie
    sameSite: 'lax',            // other sites can't send it with their form posts
    // Plain http on the LAN by default. Set COOKIE_SECURE=true if you ever
    // serve the app over https, so the cookie is never sent unencrypted.
    secure: process.env.COOKIE_SECURE === 'true'
  }
}));
app.use(flash());
app.use(refreshSessionUser); // role / deactivation changes apply on the next request

// Basic browser hardening headers (no dependency needed for these).
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

// Values every page template can use.
app.use((req, res, next) => {
  const user = req.session.user || null;
  res.locals.homeUrl = user ? (ROLE_HOME[user.role] || '/') : '/login';
  res.locals.can = capability => !!user && can(user.role, capability);
  res.locals.roleLabel = user ? (ROLE_LABELS[user.role] || user.role) : '';
  res.locals.ymd = ymd;
  res.locals.currentPath = req.path;
  res.locals.toasts = { success: req.flash('success'), error: req.flash('error') };
  next();
});

app.use(csrf);

// Anyone still on the starter password must change it before going on.
app.use((req, res, next) => {
  if (!req.session.user || !req.session.mustChangePassword) return next();
  if (req.path === '/account/change-password' || req.path === '/logout') return next();
  if (req.method === 'GET') return res.redirect('/account/change-password');
  return res.status(403).render('error', {
    message: 'Choose your own password before continuing.', user: req.session.user
  });
});

app.use('/', authRoutes);
app.use('/account', accountRoutes);
app.use('/production', productionRoutes);
app.use('/maintenance', maintenanceRoutes);
app.use('/toolroom', toolroomRoutes);
app.use('/purchasing', purchasingRoutes);
app.use('/management', managementRoutes);

app.get('/', (req, res) => {
  res.redirect(req.session.user ? res.locals.homeUrl : '/login');
});

app.use((req, res) => {
  res.status(404).render('error', { heading: 'Page not found', message: 'That page does not exist, or the link is out of date.', user: req.session.user || null });
});

// Central error handler: any error thrown in a route ends up here. The
// user sees a plain message; the details go to the server console only
// (never stack traces or SQL in the browser).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return;
  res.status(500).render('error', {
    heading: 'Something went wrong',
    message: 'The system could not complete that request. Check whether your change was saved before trying again, and tell the administrator if it keeps happening.',
    user: (req.session && req.session.user) || null
  }, (renderErr, html) => {
    if (renderErr) return res.type('text').send('Something went wrong. Try again.');
    res.send(html);
  });
});

module.exports = app;
