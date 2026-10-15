// The only code allowed to change job_orders.status.
//
// Every route that moves a job order calls this module inside its own
// database transaction. It checks the move is allowed from the job's
// current status, applies it, and writes the timeline row with the status
// it moved FROM and TO (columns added by migration 003).
//
// Two kinds of change:
//
//  1. A person's decision: accept, cancel, complete. Allowed only from the
//     statuses listed in MOVES. Anything else is refused with a
//     TransitionError, so a stale page or a double click can't, for
//     example, complete a job that was cancelled meanwhile.
//
//  2. Parts progress, recalculated from the job's material requests
//     whenever the Toolroom or Purchasing changes one (syncParts):
//       any request with no stock (waiting on a purchase) -> awaiting_purchase
//       otherwise any request still with the Toolroom     -> tool_requested
//       otherwise every request issued                    -> issued
//     Before Phase 3 each Toolroom action set the status directly, so a job
//     could show "Tools Issued" while another part was still on order, and
//     issuing a part for a completed job reopened it. A completed or
//     cancelled job now never changes here: the event is still recorded on
//     its timeline.
const { ACTIVE_STATUSES } = require('../constants/jobOrderStatus');

const MOVES = {
  accept: { from: ['pending'], to: 'accepted' },
  cancel: { from: ['pending'], to: 'cancelled' },
  complete: { from: ACTIVE_STATUSES, to: 'completed' }
};

class TransitionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransitionError';
  }
}

// Locks the job row for the rest of the transaction. null if not found.
async function lock(conn, jobId) {
  const [rows] = await conn.query('SELECT * FROM job_orders WHERE id = ? FOR UPDATE', [jobId]);
  return rows[0] || null;
}

async function writeLog(conn, jobId, event, userId, remarks, from, to) {
  await conn.query(
    `INSERT INTO job_order_status_log (job_order_id, status, from_status, to_status, changed_by, remarks)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [jobId, event, from, to, userId, remarks || null]);
}

// A person's decision. `job` must come from lock() in this transaction.
async function move(conn, job, moveName, { userId, remarks } = {}) {
  const m = MOVES[moveName];
  if (!m) throw new Error(`Unknown job order move "${moveName}"`);
  if (!m.from.includes(job.status)) {
    throw new TransitionError(`This job order is "${job.status}", so it can't be ${m.to} now. Reload the page to see its current state.`);
  }
  await conn.query('UPDATE job_orders SET status = ? WHERE id = ?', [m.to, job.id]);
  await writeLog(conn, job.id, m.to, userId, remarks, job.status, m.to);
  const from = job.status;
  job.status = m.to;
  return { from, to: m.to };
}

// Status implied by a job's material requests, or null if it has none.
function partsStatus(requestStatuses) {
  if (!requestStatuses.length) return null;
  if (requestStatuses.includes('not_available')) return 'awaiting_purchase';
  if (requestStatuses.some(s => s === 'pending' || s === 'checking' || s === 'available')) return 'tool_requested';
  return 'issued';
}

// Records a parts event (`event` names it on the timeline: tool_requested,
// issued, awaiting_purchase, received) and moves an open job to the
// status its requests imply.
async function syncParts(conn, jobId, { event, userId, remarks } = {}) {
  const job = await lock(conn, jobId);
  if (!job) throw new Error(`Job order ${jobId} not found`);
  const [reqs] = await conn.query('SELECT status FROM material_requests WHERE job_order_id = ?', [jobId]);
  let to = null;
  if (ACTIVE_STATUSES.includes(job.status)) {
    const implied = partsStatus(reqs.map(r => r.status));
    if (implied && implied !== job.status) to = implied;
  }
  if (to) await conn.query('UPDATE job_orders SET status = ? WHERE id = ?', [to, jobId]);
  await writeLog(conn, jobId, event, userId, remarks, to ? job.status : null, to);
  return to || job.status;
}

module.exports = { MOVES, TransitionError, lock, move, syncParts, partsStatus, writeLog };
