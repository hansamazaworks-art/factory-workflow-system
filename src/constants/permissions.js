// Who may do what. The ONE place access is decided: routes check these
// names with requirePermission(), pages hide what a user can't do with
// can(), and the sidebar is built from them. Approved in the Phase 1 plan
// (section F); later phases add capabilities here as features arrive.
//
// "admin" has every capability. Asking for a name that isn't listed here
// throws at startup, so a typo can never silently open or close a page.

const ROLE_LABELS = {
  production: 'Production',
  maintenance: 'Maintenance Technician',
  maintenance_manager: 'Maintenance Manager',
  plant_manager: 'Plant Manager',
  toolroom: 'Tool Room',
  purchasing: 'Purchasing',
  management: 'Management',
  admin: 'Administrator'
};
const ROLES = Object.keys(ROLE_LABELS);

const MAINTENANCE_VIEWERS = ['maintenance', 'maintenance_manager', 'plant_manager', 'management'];

const CAPABILITIES = {
  // Department areas (unchanged from before Phase 3)
  'production.access': ['production'],
  'toolroom.access': ['toolroom'],
  'purchasing.access': ['purchasing'],
  'management.access': ['management'],

  // Maintenance: seeing
  'maintenance.view': MAINTENANCE_VIEWERS,        // dashboard, job order pages
  'maintenance.kpi.view': MAINTENANCE_VIEWERS,
  'pm.view': MAINTENANCE_VIEWERS,
  'settings.view': ['maintenance_manager', 'plant_manager', 'management'],

  // Maintenance: doing
  // Taking a job from the queue. Transitional until Phase 5, which replaces
  // it with the manager acknowledging, triaging and assigning (plan G).
  'jobs.accept': ['maintenance', 'maintenance_manager'],
  'jobs.work.own': ['maintenance', 'maintenance_manager'],  // request parts / complete jobs you accepted
  'jobs.work.any': ['maintenance_manager'],                 // ... and jobs someone else accepted
  'pm.complete': ['maintenance', 'maintenance_manager'],    // log a PM done or skipped
  'pm.manage': ['maintenance_manager'],                     // create, pause, resume PM schedules
  'settings.manage': ['maintenance_manager']
};

function assertKnown(capability) {
  if (!Object.prototype.hasOwnProperty.call(CAPABILITIES, capability)) {
    throw new Error(`Unknown capability "${capability}". Add it to src/constants/permissions.js.`);
  }
}

function can(role, capability) {
  assertKnown(capability);
  return role === 'admin' || CAPABILITIES[capability].includes(role);
}

module.exports = { ROLES, ROLE_LABELS, CAPABILITIES, can, assertKnown };
