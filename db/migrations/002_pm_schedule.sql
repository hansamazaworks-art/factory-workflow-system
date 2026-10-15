-- ============================================================
-- MIGRATION 002: Preventive Maintenance Schedule (PMS) & KPIs
-- Run this once against an EXISTING factory_system database that was
-- created before this change (i.e. its schema.sql didn't yet include
-- pm_schedules / pm_completions). Safe to re-run - both tables use
-- IF NOT EXISTS.
--
-- How to run:
--   mysql -u <user> -p factory_system < db/migrations/002_pm_schedule.sql
-- or paste the contents into MySQL Workbench / phpMyAdmin.
--
-- If you're setting up a brand-new database, skip this file - just
-- run db/schema.sql, which already includes these tables.
--
-- No changes to the KPI Dashboard are needed here - it's read-only
-- and computed entirely from job_orders / maintenance_actions
-- (already in your database) plus these two new PM tables.
-- ============================================================

USE factory_system;

CREATE TABLE IF NOT EXISTS pm_schedules (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    machine_id      INT NOT NULL,
    task_name       VARCHAR(150) NOT NULL,
    description     TEXT DEFAULT NULL,
    frequency_days  INT NOT NULL,
    next_due_date   DATE NOT NULL,
    last_done_date  DATE DEFAULT NULL,
    is_active       TINYINT(1) NOT NULL DEFAULT 1,
    created_by      INT NOT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (machine_id) REFERENCES machines(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS pm_completions (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    pm_schedule_id  INT NOT NULL,
    due_date        DATE NOT NULL,
    completed_date  DATE NOT NULL,
    status          ENUM('done','skipped') NOT NULL DEFAULT 'done',
    notes           TEXT DEFAULT NULL,
    completed_by    INT NOT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pm_schedule_id) REFERENCES pm_schedules(id),
    FOREIGN KEY (completed_by) REFERENCES users(id)
);
