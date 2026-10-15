// Shared math for Floor Control: target opens from cycle time, downtime
// overlap, achievement %, etc. Times are "HH:MM" or "HH:MM:SS" strings.

function timeToMin(t) {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// Minutes between two HH:MM times on the same logical shift, rolling
// over midnight if end < start (overnight run).
function minutesBetween(start, end) {
  let s = timeToMin(start);
  let e = timeToMin(end);
  if (e < s) e += 1440;
  return e - s;
}

function overlapMinutesRaw(aStart, aEnd, bStart, bEnd) {
  return Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
}

// Sums downtime (already-logged rows) that overlaps a given run window,
// so a breakdown isn't double-penalized against the target.
function downtimeOverlapMinutes(downtimeRows, startTime, endTime) {
  let s = timeToMin(startTime);
  let e = timeToMin(endTime);
  if (e < s) e += 1440;
  return downtimeRows.reduce((sum, d) => {
    let ds = timeToMin(d.start_time);
    let de = timeToMin(d.end_time);
    if (de < ds) de += 1440;
    return sum + overlapMinutesRaw(s, e, ds, de);
  }, 0);
}

function computeTargetOpens(cycleTimeSec, availableSec) {
  if (!cycleTimeSec || cycleTimeSec <= 0 || availableSec <= 0) return 0;
  return Math.floor(availableSec / cycleTimeSec);
}

// Derives every number a production entry needs, given raw form inputs
// plus the machine's downtime rows for that date/shift.
function computeEntryMetrics({ startTime, endTime, cycleTimeSec, cavities, machineOpens, rejectQty, downtimeRows }) {
  const rawElapsedSec = minutesBetween(startTime, endTime) * 60;
  const downtimeExcludedMin = downtimeOverlapMinutes(downtimeRows || [], startTime, endTime);
  const availableSec = Math.max(0, rawElapsedSec - downtimeExcludedMin * 60);
  const targetOpens = computeTargetOpens(cycleTimeSec, availableSec);
  const gross = machineOpens * cavities;
  const good = gross - rejectQty;
  const rejectRatePct = gross > 0 ? (rejectQty / gross) * 100 : 0;
  const targetPieces = targetOpens * cavities;
  const achievementPct = targetPieces > 0 ? (gross / targetPieces) * 100 : null;
  const actualCycleSec = (availableSec > 0 && machineOpens > 0) ? availableSec / machineOpens : null;
  const cycleVariancePct = (actualCycleSec !== null && cycleTimeSec > 0)
    ? ((actualCycleSec - cycleTimeSec) / cycleTimeSec) * 100
    : null;
  return {
    availableSec, downtimeExcludedMin, targetOpens, gross, good,
    rejectRatePct, targetPieces, achievementPct, actualCycleSec, cycleVariancePct
  };
}

function fmtDuration(sec) {
  if (!sec || sec <= 0) return '0m';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// "HH:MM:SS" for a JS Date, in local (server) time - used to turn the
// DATETIME columns the Live Floor board writes (started_at, ended_at)
// into the same "HH:MM" time-of-day strings production_entries and
// downtime_logs have always used, so existing Reports/Analytics math
// doesn't need to change.
function toHMS(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Which shift is "now" in, for defaulting the Start Run form. Handles
// an overnight shift (end time earlier than start time) by wrapping
// past midnight. Falls back to the first shift if none match.
function currentShiftId(shifts, now = new Date()) {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const s of shifts) {
    const start = timeToMin(s.start_time);
    const end = timeToMin(s.end_time);
    const overnight = s.is_overnight || end <= start;
    const inShift = overnight
      ? (nowMin >= start || nowMin < end)
      : (nowMin >= start && nowMin < end);
    if (inShift) return s.id;
  }
  return shifts.length ? shifts[0].id : null;
}

module.exports = {
  timeToMin, minutesBetween, overlapMinutesRaw, downtimeOverlapMinutes,
  computeTargetOpens, computeEntryMetrics, fmtDuration, toHMS, currentShiftId
};
