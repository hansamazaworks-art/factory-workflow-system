// One company time zone for every date the app shows, compares or stores.
//
// Before this, "today" came from toISOString(), which is always UTC: on a
// host PC in the Philippines that is yesterday until 08:00, and DATE
// columns (read as local midnight) printed as the day before. That shifted
// the Analytics chart by a day and made PM due dates drift a day early on
// every completion.
//
// Set COMPANY_TIMEZONE in .env (an IANA name such as Asia/Manila).
// Loading this file makes Node use that zone for every Date, and
// src/config/db.js puts each database connection on the same UTC offset,
// so NOW() and CURDATE() agree with the app whatever the PC clock says.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const TIMEZONE = process.env.COMPANY_TIMEZONE || 'Asia/Manila';

try {
  new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE });
} catch (e) {
  throw new Error(`COMPANY_TIMEZONE "${TIMEZONE}" is not a valid time zone name. Use one like Asia/Manila.`);
}

process.env.TZ = TIMEZONE;

// The zone's UTC offset at a moment, as "+08:00" (the form MySQL accepts
// without time zone tables installed, which XAMPP does not have).
function utcOffset(date = new Date()) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(date).forEach(p => { parts[p.type] = Number(p.value); });
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const minutes = Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

module.exports = { TIMEZONE, utcOffset };
