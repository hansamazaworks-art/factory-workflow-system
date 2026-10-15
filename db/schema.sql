-- ============================================================
-- FACTORY WORKFLOW SYSTEM - BASE DATABASE SCHEMA
-- Covers: Production -> Maintenance -> Toolroom -> Purchasing -> Management
--
-- For a NEW installation: run this file, then `npm run migrate`, which
-- adds everything from db/migrations (roles, audit trail, settings, ...).
-- Existing installations only need `npm run migrate`.
--
-- NOTE: Only tables used by Phase 1 (Production: create job order)
-- have working application code right now. The rest of the tables
-- are included here so every later phase has a stable place to
-- plug into, without needing to redesign the database each time.
-- ============================================================

CREATE DATABASE IF NOT EXISTS factory_system;
USE factory_system;

-- ------------------------------------------------------------
-- 1. USERS & ROLES
-- One login table for everyone. The `role` column decides which
-- dashboard/menu a person sees after logging in.
-- ------------------------------------------------------------
CREATE TABLE users (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    username        VARCHAR(50) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    full_name       VARCHAR(100) NOT NULL,
    role            ENUM('production','maintenance','toolroom','purchasing','management','admin') NOT NULL,
    department      VARCHAR(100) DEFAULT NULL,
    is_active       TINYINT(1) NOT NULL DEFAULT 1,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- 2. JOB ORDERS  (Phase 1 - Production)
-- Created by Production when a machine/line needs maintenance.
-- ------------------------------------------------------------
CREATE TABLE job_orders (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    jo_number       VARCHAR(20) NOT NULL UNIQUE,          -- e.g. JO-2026-0001
    requested_by    INT NOT NULL,                          -- users.id (production)
    machine_name    VARCHAR(150) NOT NULL,
    location        VARCHAR(150) DEFAULT NULL,
    problem_desc    TEXT NOT NULL,
    priority        ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
    status          ENUM(
                        'pending',              -- just created, waiting for maintenance
                        'accepted',             -- maintenance accepted the job
                        'tool_requested',       -- maintenance requested tools/materials
                        'checking_stock',       -- toolroom checking availability
                        'ready_to_issue',       -- toolroom confirms stock available
                        'issued',               -- toolroom issued the tools/materials
                        'awaiting_purchase',    -- stock not available, requisition raised
                        'in_progress',          -- maintenance working on it
                        'completed',            -- job finished
                        'cancelled'
                    ) NOT NULL DEFAULT 'pending',
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (requested_by) REFERENCES users(id)
);

-- Full audit trail of every status change on a job order, and by whom.
-- Every module (maintenance, toolroom, purchasing, management) writes here.
CREATE TABLE job_order_status_log (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    job_order_id    INT NOT NULL,
    status          VARCHAR(30) NOT NULL,
    changed_by      INT NOT NULL,
    remarks         TEXT DEFAULT NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (job_order_id) REFERENCES job_orders(id),
    FOREIGN KEY (changed_by) REFERENCES users(id)
);

-- ------------------------------------------------------------
-- 3. MAINTENANCE  (Phase 2)
-- Maintenance accepts a job order, then may request tools/materials.
-- ------------------------------------------------------------
CREATE TABLE maintenance_actions (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    job_order_id    INT NOT NULL,
    accepted_by     INT NOT NULL,                          -- users.id (maintenance)
    notes           TEXT DEFAULT NULL,
    accepted_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at    DATETIME DEFAULT NULL,
    FOREIGN KEY (job_order_id) REFERENCES job_orders(id),
    FOREIGN KEY (accepted_by) REFERENCES users(id)
);

CREATE TABLE material_requests (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    job_order_id    INT NOT NULL,
    requested_by    INT NOT NULL,                          -- users.id (maintenance)
    item_name       VARCHAR(150) NOT NULL,
    quantity        DECIMAL(10,2) NOT NULL,
    unit            VARCHAR(20) NOT NULL,
    status          ENUM('pending','checking','available','not_available','issued') NOT NULL DEFAULT 'pending',
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (job_order_id) REFERENCES job_orders(id),
    FOREIGN KEY (requested_by) REFERENCES users(id)
);

-- ------------------------------------------------------------
-- 4. TOOLROOM  (Phase 3)
-- Checks material_requests against inventory. If short, raises a
-- purchase_requisition.
-- ------------------------------------------------------------
CREATE TABLE inventory (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    item_name       VARCHAR(150) NOT NULL,
    sku             VARCHAR(50) DEFAULT NULL,
    quantity_on_hand DECIMAL(10,2) NOT NULL DEFAULT 0,
    unit            VARCHAR(20) NOT NULL,
    reorder_level   DECIMAL(10,2) NOT NULL DEFAULT 0,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- 5. PURCHASING  (Phase 4)
-- ------------------------------------------------------------
CREATE TABLE purchase_requisitions (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    material_request_id INT NOT NULL,
    raised_by           INT NOT NULL,                      -- users.id (toolroom)
    item_name            VARCHAR(150) NOT NULL,
    quantity             DECIMAL(10,2) NOT NULL,
    unit                 VARCHAR(20) NOT NULL,
    status               ENUM('pending','po_created','completed','rejected') NOT NULL DEFAULT 'pending',
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (material_request_id) REFERENCES material_requests(id),
    FOREIGN KEY (raised_by) REFERENCES users(id)
);

CREATE TABLE purchase_orders (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    requisition_id  INT NOT NULL,
    po_number       VARCHAR(20) NOT NULL UNIQUE,           -- e.g. PO-2026-0001
    created_by      INT NOT NULL,                          -- users.id (purchasing)
    supplier        VARCHAR(150) DEFAULT NULL,
    unit_price      DECIMAL(12,2) DEFAULT NULL,
    total_amount    DECIMAL(12,2) DEFAULT NULL,
    status          ENUM('pending_approval','approved','rejected','ordered','received') NOT NULL DEFAULT 'pending_approval',
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (requisition_id) REFERENCES purchase_requisitions(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
);

-- ------------------------------------------------------------
-- 6. MANAGEMENT APPROVAL  (Phase 5)
-- ------------------------------------------------------------
CREATE TABLE approvals (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    purchase_order_id INT NOT NULL,
    decided_by      INT NOT NULL,                          -- users.id (management)
    decision        ENUM('approved','rejected') NOT NULL,
    remarks         TEXT DEFAULT NULL,
    decided_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id),
    FOREIGN KEY (decided_by) REFERENCES users(id)
);

-- ------------------------------------------------------------
-- 7. FLOOR CONTROL  (Production)
-- Machines, molds, operators, shift-based production entries and
-- downtime. Independent of the Job Order workflow above, but lives
-- under the same "production" role.
-- ------------------------------------------------------------

CREATE TABLE shifts (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(50) NOT NULL,
    start_time      TIME NOT NULL,
    end_time        TIME NOT NULL,
    is_overnight    TINYINT(1) NOT NULL DEFAULT 0
);

CREATE TABLE machines (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    code            VARCHAR(20) NOT NULL UNIQUE,
    name            VARCHAR(150) NOT NULL,
    location        VARCHAR(150) DEFAULT NULL,
    status          ENUM('running','idle','down','maintenance') NOT NULL DEFAULT 'idle',
    is_active       TINYINT(1) NOT NULL DEFAULT 1,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE molds (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    code                VARCHAR(20) NOT NULL UNIQUE,
    name                VARCHAR(150) NOT NULL,
    product             VARCHAR(150) DEFAULT NULL,
    cavities            INT NOT NULL DEFAULT 1,
    standard_cycle_sec  DECIMAL(6,2) DEFAULT NULL,
    is_active           TINYINT(1) NOT NULL DEFAULT 1,
    created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE operators (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    employee_code   VARCHAR(20) DEFAULT NULL,
    name            VARCHAR(150) NOT NULL,
    is_active       TINYINT(1) NOT NULL DEFAULT 1,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The mold currently (or previously) mounted on a machine. Only one
-- row per machine should have unassigned_at IS NULL at a time - that
-- is the "active" assignment production entries and downtime refer to.
CREATE TABLE mold_assignments (
    id                  INT AUTO_INCREMENT PRIMARY KEY,
    machine_id          INT NOT NULL,
    mold_id             INT NOT NULL,
    cavities_snapshot   INT NOT NULL,
    standard_cycle_sec  DECIMAL(6,2) DEFAULT NULL,
    assigned_by         INT NOT NULL,                      -- users.id (production)
    assigned_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    unassigned_at       DATETIME DEFAULT NULL,
    remarks             TEXT DEFAULT NULL,
    FOREIGN KEY (machine_id) REFERENCES machines(id),
    FOREIGN KEY (mold_id) REFERENCES molds(id),
    FOREIGN KEY (assigned_by) REFERENCES users(id)
);

CREATE TABLE downtime_logs (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    machine_id      INT NOT NULL,
    log_date        DATE NOT NULL,
    shift_id        INT DEFAULT NULL,
    start_time      TIME NOT NULL,
    end_time        TIME NOT NULL,
    reason          VARCHAR(150) NOT NULL,
    remarks         TEXT DEFAULT NULL,
    logged_by       INT NOT NULL,                          -- users.id (production)
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (machine_id) REFERENCES machines(id),
    FOREIGN KEY (shift_id) REFERENCES shifts(id),
    FOREIGN KEY (logged_by) REFERENCES users(id)
);

-- One row per machine/shift/run logged on the floor. Target opens are
-- derived from cycle time and the available run time (clock time minus
-- any logged downtime that overlaps the run), so achievement % reflects
-- real machine availability rather than raw wall-clock time.
CREATE TABLE production_entries (
    id                      INT AUTO_INCREMENT PRIMARY KEY,
    entry_date              DATE NOT NULL,
    shift_id                INT NOT NULL,
    machine_id              INT NOT NULL,
    assignment_id           INT NOT NULL,
    mold_id                 INT NOT NULL,
    operator_id             INT NOT NULL,
    start_time              TIME NOT NULL,
    end_time                TIME NOT NULL,
    opens_method            ENUM('direct','counter') NOT NULL DEFAULT 'direct',
    prev_counter            INT DEFAULT NULL,
    curr_counter            INT DEFAULT NULL,
    machine_opens           INT NOT NULL DEFAULT 0,
    cavities_snapshot       INT NOT NULL,
    cycle_time_sec          DECIMAL(6,2) DEFAULT NULL,
    target_opens            INT DEFAULT NULL,
    downtime_excluded_min   DECIMAL(6,1) NOT NULL DEFAULT 0,
    reject_qty              INT NOT NULL DEFAULT 0,
    remarks                 TEXT DEFAULT NULL,
    created_by              INT NOT NULL,                  -- users.id (production)
    created_at              DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (shift_id) REFERENCES shifts(id),
    FOREIGN KEY (machine_id) REFERENCES machines(id),
    FOREIGN KEY (assignment_id) REFERENCES mold_assignments(id),
    FOREIGN KEY (mold_id) REFERENCES molds(id),
    FOREIGN KEY (operator_id) REFERENCES operators(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Live state for a machine currently running (or down) under the Live
-- Floor board. Only one row per machine should have status IN
-- ('running','down') at a time - that's the active run. Ending it via
-- "Finish Shift" writes a production_entries row (below) and flips this
-- row to 'ended', keeping full history without disturbing Reports.
CREATE TABLE machine_runs (
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
    production_entry_id INT DEFAULT NULL,               -- filled in once "Finish Shift" closes this run
    FOREIGN KEY (machine_id) REFERENCES machines(id),
    FOREIGN KEY (shift_id) REFERENCES shifts(id),
    FOREIGN KEY (assignment_id) REFERENCES mold_assignments(id),
    FOREIGN KEY (mold_id) REFERENCES molds(id),
    FOREIGN KEY (operator_id) REFERENCES operators(id),
    FOREIGN KEY (started_by) REFERENCES users(id),
    FOREIGN KEY (ended_by) REFERENCES users(id),
    FOREIGN KEY (production_entry_id) REFERENCES production_entries(id)
);

-- One-click downtime toggles punched from the Live Floor board while a
-- run is active. A closed segment is also mirrored into downtime_logs
-- (above) so existing Reports/Analytics queries need no changes.
CREATE TABLE run_downtimes (
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

-- ------------------------------------------------------------
-- 8. PREVENTIVE MAINTENANCE SCHEDULE (PMS) & KPI TRACKING
-- (Maintenance role.) A recurring task tied to a machine (e.g.
-- "Lubricate hydraulics every 30 days"). next_due_date drives the
-- Overdue/Due Soon views on the Maintenance PM Schedule page.
-- Completing or skipping a task writes a row to pm_completions and
-- rolls next_due_date forward, which also feeds the PM Compliance
-- KPI on the Maintenance KPI Dashboard (which otherwise reads
-- job_orders/maintenance_actions directly - no new tables needed
-- for the job-order side of KPI tracking).
-- ------------------------------------------------------------
CREATE TABLE pm_schedules (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    machine_id      INT NOT NULL,
    task_name       VARCHAR(150) NOT NULL,
    description     TEXT DEFAULT NULL,
    frequency_days  INT NOT NULL,               -- e.g. 30 = every 30 days
    next_due_date   DATE NOT NULL,
    last_done_date  DATE DEFAULT NULL,
    is_active       TINYINT(1) NOT NULL DEFAULT 1,
    created_by      INT NOT NULL,                -- users.id (maintenance)
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (machine_id) REFERENCES machines(id),
    FOREIGN KEY (created_by) REFERENCES users(id)
);

-- One row every time a PM task is actioned (done or skipped), so the
-- schedule's full history is kept even as next_due_date rolls forward.
CREATE TABLE pm_completions (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    pm_schedule_id  INT NOT NULL,
    due_date        DATE NOT NULL,               -- what it was due on
    completed_date  DATE NOT NULL,
    status          ENUM('done','skipped') NOT NULL DEFAULT 'done',
    notes           TEXT DEFAULT NULL,
    completed_by    INT NOT NULL,                -- users.id (maintenance)
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (pm_schedule_id) REFERENCES pm_schedules(id),
    FOREIGN KEY (completed_by) REFERENCES users(id)
);

-- ------------------------------------------------------------
-- SEED DATA
-- Do NOT insert plain-text or hand-typed password hashes here.
-- Run `npm run seed` after setup instead (see README) - it creates
-- one login per role with a real bcrypt hash, and prints the
-- generated password once to your terminal.
-- ------------------------------------------------------------
