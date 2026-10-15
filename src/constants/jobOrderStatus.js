// Job order status groups, shared by every module.
// (Display text for each status lives in statusLabels.js.)

// Still open: Maintenance has the job and is working it.
const ACTIVE_STATUSES = [
  'accepted', 'tool_requested', 'checking_stock',
  'ready_to_issue', 'issued', 'awaiting_purchase', 'in_progress'
];

// Finished: nothing may move a job out of these.
const CLOSED_STATUSES = ['completed', 'cancelled'];

module.exports = { ACTIVE_STATUSES, CLOSED_STATUSES };
