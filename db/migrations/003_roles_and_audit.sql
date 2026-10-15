-- ============================================================
-- MIGRATION 003: Maintenance roles and audit trail  (Phase 3)
--
-- Run with:  npm run migrate        (takes a backup first)
-- Undo with: npm run migrate -- down
--
-- What it changes (additive only, no existing data is altered):
--   1. users.role gains two values: plant_manager, maintenance_manager.
--      Existing users keep their current role.
--   2. job_order_status_log gains from_status / to_status, so every
--      status change records what it changed from and to. Older rows
--      keep NULL there: their status column already names the event.
--   3. New table audit_log: who changed what, old and new value, why.
--   4. Triggers make audit_log and job_order_status_log append-only:
--      the database itself refuses to edit or delete their rows.
--
-- Written for MariaDB 10.4+ (XAMPP). Every statement can be re-run.
-- ============================================================

ALTER TABLE users
  MODIFY COLUMN role ENUM('production','maintenance','toolroom','purchasing','management','admin',
                          'plant_manager','maintenance_manager') NOT NULL;

ALTER TABLE job_order_status_log
  ADD COLUMN IF NOT EXISTS from_status VARCHAR(30) DEFAULT NULL AFTER status,
  ADD COLUMN IF NOT EXISTS to_status   VARCHAR(30) DEFAULT NULL AFTER from_status;

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  entity      VARCHAR(40)  NOT NULL,              -- what kind of record: user, maintenance_setting, ...
  entity_id   VARCHAR(64)  NOT NULL,              -- which one
  action      VARCHAR(40)  NOT NULL,              -- create, update, role_change, deactivate, ...
  field       VARCHAR(64)  DEFAULT NULL,
  old_value   TEXT         DEFAULT NULL,
  new_value   TEXT         DEFAULT NULL,
  reason      TEXT         DEFAULT NULL,
  user_id     INT          DEFAULT NULL,          -- NULL when done from the command line
  source      VARCHAR(20)  NOT NULL DEFAULT 'web', -- web | cli
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_entity (entity, entity_id),
  KEY idx_audit_created (created_at),
  CONSTRAINT fk_audit_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only: its rows cannot be changed';

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_log is append-only: its rows cannot be deleted';

CREATE TRIGGER IF NOT EXISTS status_log_no_update BEFORE UPDATE ON job_order_status_log
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'job_order_status_log is append-only: its rows cannot be changed';

CREATE TRIGGER IF NOT EXISTS status_log_no_delete BEFORE DELETE ON job_order_status_log
  FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'job_order_status_log is append-only: its rows cannot be deleted';
