-- ============================================================
-- MIGRATION 001: Live Floor Board
-- Run this once against an EXISTING factory_system database that was
-- created before this change (i.e. its schema.sql didn't yet include
-- machine_runs / run_downtimes). Safe to re-run - both tables use
-- IF NOT EXISTS.
--
-- How to run:
--   mysql -u <user> -p factory_system < db/migrations/001_live_floor_board.sql
-- or paste the contents into MySQL Workbench / phpMyAdmin.
--
-- If you're setting up a brand-new database, skip this file - just
-- run db/schema.sql, which already includes these tables.
-- ============================================================

USE factory_system;

CREATE TABLE IF NOT EXISTS machine_runs (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    machine_id          INT NOT NULL,
    entry_date          DATE NOT NULL,
    shift_id            INT NOT NULL,
    assignment_id       INT NOT NULL,
    mold_id             INT NOT NULL,
    operator_id         INT NOT NULL,
    cavities_snapshot   INT NOT NULL,
    cycle_time_sec      DECIMAL(6,2) DEFAULT NULL,
    status              ENUM('running','down','ended') NOT NULL DEFAULT 'running',
    started_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_by          INT NOT NULL,
    ended_at            DATETIME DEFAULT NULL,
    ended_by            INT DEFAULT NULL,
    production_entry_id INT DEFAULT NULL,
    FOREIGN KEY (machine_id) REFERENCES machines(id),
    FOREIGN KEY (shift_id) REFERENCES shifts(id),
    FOREIGN KEY (assignment_id) REFERENCES mold_assignments(id),
    FOREIGN KEY (mold_id) REFERENCES molds(id),
    FOREIGN KEY (operator_id) REFERENCES operators(id),
    FOREIGN KEY (started_by) REFERENCES users(id),
    FOREIGN KEY (ended_by) REFERENCES users(id),
    FOREIGN KEY (production_entry_id) REFERENCES production_entries(id)
);

CREATE TABLE IF NOT EXISTS run_downtimes (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    machine_run_id  INT NOT NULL,
    reason          VARCHAR(150) NOT NULL,
    remarks         TEXT DEFAULT NULL,
    started_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at        DATETIME DEFAULT NULL,
    logged_by       INT NOT NULL,
    FOREIGN KEY (machine_run_id) REFERENCES machine_runs(id),
    FOREIGN KEY (logged_by) REFERENCES users(id)
);
