// Calendar-date helpers. A "day" is always a YYYY-MM-DD string in the
// company time zone. Never use toISOString() for a calendar date: it is UTC.
const { TIMEZONE } = require('../config/timezone');

const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
});
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

// Today in the company time zone.
function today(now = new Date()) {
  return DAY_FORMAT.format(now);
}

// A DATE column (mysql2 gives a Date at local midnight), a DATETIME, or a
// string → 'YYYY-MM-DD'. Empty values → ''.
function ymd(value) {
  if (value === null || value === undefined || value === '') return '';
  if (value instanceof Date) return isNaN(value) ? '' : DAY_FORMAT.format(value);
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : '';
}

// True only for a real calendar date written YYYY-MM-DD (rejects 2026-02-30).
function isYmd(s) {
  const m = YMD.exec(String(s || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

// Calendar arithmetic on the date itself, so month ends, leap years and
// clock changes can't move the result.
function addDays(day, n) {
  const m = YMD.exec(day);
  if (!m) throw new Error(`addDays needs YYYY-MM-DD, got "${day}"`);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)).toISOString().slice(0, 10);
}

// 'Mon', 'Tue', ... for a YYYY-MM-DD day.
function weekdayShort(day) {
  const m = YMD.exec(day);
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
    .toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

module.exports = { today, ymd, isYmd, addDays, weekdayShort };
