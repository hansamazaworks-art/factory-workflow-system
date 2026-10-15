// Slows down password guessing on the login form, without dependencies.
// After MAX_FAILURES wrong passwords for the same username from the same
// computer within WINDOW_MS, that pair is locked out until the window
// passes. A successful login clears the count. Kept in memory: a server
// restart clears it, which is acceptable for a single LAN host.
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map(); // key -> array of failure timestamps

const keyFor = (req, username) => `${req.ip}|${String(username || '').toLowerCase()}`;

function recent(key, now = Date.now()) {
  const list = (failures.get(key) || []).filter(t => now - t < WINDOW_MS);
  if (list.length) failures.set(key, list); else failures.delete(key);
  return list;
}

// Minutes left on a lockout, or 0 when the user may try.
function lockedFor(req, username) {
  const list = recent(keyFor(req, username));
  if (list.length < MAX_FAILURES) return 0;
  return Math.ceil((list[0] + WINDOW_MS - Date.now()) / 60000);
}

function recordFailure(req, username) {
  const key = keyFor(req, username);
  const list = recent(key);
  list.push(Date.now());
  failures.set(key, list);
  if (failures.size > 10000) failures.delete(failures.keys().next().value); // bound memory
}

function clear(req, username) {
  failures.delete(keyFor(req, username));
}

module.exports = { lockedFor, recordFailure, clear, MAX_FAILURES, _reset: () => failures.clear() };
