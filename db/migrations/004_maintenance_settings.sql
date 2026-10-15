-- ============================================================
-- MIGRATION 004: Maintenance Settings  (Phase 3)
--
-- Moves the "overdue after N hours" targets out of the code and into a
-- table the Maintenance Manager edits on the Maintenance Settings page.
-- The values below are the ones the code used until now, so the KPI
-- Dashboard shows exactly the same overdue jobs after this migration.
-- Every change made on the page is recorded in audit_log (migration 003).
-- ============================================================

CREATE TABLE IF NOT EXISTS maintenance_settings (
  setting_key    VARCHAR(64)  PRIMARY KEY,
  setting_value  VARCHAR(255) NOT NULL,
  updated_by     INT          DEFAULT NULL,
  updated_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_settings_user FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO maintenance_settings (setting_key, setting_value) VALUES
  ('overdue_hours_urgent', '4'),
  ('overdue_hours_high',   '24'),
  ('overdue_hours_normal', '72'),
  ('overdue_hours_low',    '168');
