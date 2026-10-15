// Login-related constants shared by routes, middleware and db/seed.js.

// Where each role lands after logging in (and the "home" link on error
// pages). New roles are added here as their dashboards are built.
const ROLE_HOME = {
  production: '/production/dashboard',
  maintenance: '/maintenance/dashboard',
  toolroom: '/toolroom/dashboard',
  purchasing: '/purchasing/dashboard',
  management: '/management/dashboard',
  maintenance_manager: '/maintenance/dashboard',
  plant_manager: '/maintenance/kpi',
  admin: '/production/dashboard'
};

module.exports = {
  // The starter password `npm run seed` gives every test login. Anyone who
  // logs in with it must choose a new one before using the system, and it
  // can never be chosen as a new password.
  SEED_PASSWORD: 'password123',
  MIN_PASSWORD_LENGTH: 8,
  ROLE_HOME
};
