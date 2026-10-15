// Append-only change history (table audit_log, migration 003).
// The database refuses UPDATE and DELETE on it, so a row once written stays.
// Job order status changes are recorded in job_order_status_log instead,
// which is protected the same way.

async function record(db, e) {
  await db.query(
    `INSERT INTO audit_log (entity, entity_id, action, field, old_value, new_value, reason, user_id, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [e.entity, String(e.entityId), e.action, e.field || null,
     e.oldValue === undefined || e.oldValue === null ? null : String(e.oldValue),
     e.newValue === undefined || e.newValue === null ? null : String(e.newValue),
     e.reason || null, e.userId || null, e.source || 'web']);
}

// Most recent entries for one kind of record, newest first.
async function recent(db, entity, limit = 20) {
  const [rows] = await db.query(
    `SELECT a.*, u.full_name AS user_name
     FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.entity = ? ORDER BY a.id DESC LIMIT ?`,
    [entity, limit]);
  return rows;
}

module.exports = { record, recent };
