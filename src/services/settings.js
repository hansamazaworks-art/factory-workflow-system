// Maintenance Settings (table maintenance_settings, migration 004).
// Only settings that something actually uses are offered: today that is
// the response targets the KPI Dashboard uses to flag a job as overdue.
const audit = require('./audit');

const PRIORITIES = ['urgent', 'high', 'normal', 'low'];
const DEFAULT_OVERDUE_HOURS = { urgent: 4, high: 24, normal: 72, low: 168 };
const MAX_HOURS = 8760; // one year

// { urgent, high, normal, low } in hours. Falls back to the built-in
// values if migration 004 hasn't been run, so pages never break on it.
async function overdueHours(db) {
  const out = { ...DEFAULT_OVERDUE_HOURS };
  try {
    const [rows] = await db.query("SELECT setting_key, setting_value FROM maintenance_settings WHERE setting_key LIKE 'overdue\\_hours\\_%'");
    for (const r of rows) {
      const p = r.setting_key.replace('overdue_hours_', '');
      const n = Number(r.setting_value);
      if (PRIORITIES.includes(p) && Number.isInteger(n) && n > 0) out[p] = n;
    }
  } catch (err) {
    if (err.code !== 'ER_NO_SUCH_TABLE') throw err;
  }
  return out;
}

// Checks submitted form values. Returns { values } or { errors: {field: message} }.
function validateOverdueHours(input) {
  const values = {};
  const errors = {};
  for (const p of PRIORITIES) {
    const raw = String(input[`overdue_hours_${p}`] ?? '').trim();
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < 1 || n > MAX_HOURS) {
      errors[p] = `Enter a whole number of hours from 1 to ${MAX_HOURS}.`;
    } else {
      values[p] = n;
    }
  }
  if (!Object.keys(errors).length) {
    for (let i = 1; i < PRIORITIES.length; i++) {
      const hi = PRIORITIES[i - 1];
      const lo = PRIORITIES[i];
      if (values[lo] < values[hi]) {
        errors[lo] = `Must be at least the ${hi} target (${values[hi]}h): a lower priority can't be due sooner.`;
      }
    }
  }
  return Object.keys(errors).length ? { errors } : { values };
}

// Saves changed targets and records each change (old, new, who, why).
// `conn` must be inside a transaction. Returns the priorities changed.
async function saveOverdueHours(conn, values, { userId, reason }) {
  const current = await overdueHours(conn);
  const changed = PRIORITIES.filter(p => values[p] !== current[p]);
  for (const p of changed) {
    await conn.query(
      `INSERT INTO maintenance_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
      [`overdue_hours_${p}`, String(values[p]), userId]);
    await audit.record(conn, {
      entity: 'maintenance_setting', entityId: `overdue_hours_${p}`, action: 'update',
      field: 'setting_value', oldValue: current[p], newValue: values[p], reason, userId
    });
  }
  return changed;
}

module.exports = { PRIORITIES, DEFAULT_OVERDUE_HOURS, overdueHours, validateOverdueHours, saveOverdueHours };
