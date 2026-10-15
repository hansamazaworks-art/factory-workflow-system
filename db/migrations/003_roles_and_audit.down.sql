-- Rollback of 003. Deletes the audit history recorded since 003 was
-- applied (the migrate command takes a backup first).
--
-- The role change runs FIRST on purpose: if any user still has the
-- plant_manager or maintenance_manager role, the database refuses it and
-- nothing else is undone. Move those users to another role first.

ALTER TABLE users
  MODIFY COLUMN role ENUM('production','maintenance','toolroom','purchasing','management','admin') NOT NULL;

DROP TRIGGER IF EXISTS status_log_no_delete;
DROP TRIGGER IF EXISTS status_log_no_update;
DROP TRIGGER IF EXISTS audit_log_no_delete;
DROP TRIGGER IF EXISTS audit_log_no_update;

DROP TABLE IF EXISTS audit_log;

ALTER TABLE job_order_status_log
  DROP COLUMN IF EXISTS to_status,
  DROP COLUMN IF EXISTS from_status;
