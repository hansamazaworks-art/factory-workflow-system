# Roadmap: Phases 4–12

Phases 1–3 are done (see `docs/STATUS.md`). Each phase below ends with the
app runnable, all tests green, a phase report, and the owner's approval
before the next one starts. Read `docs/DECISIONS.md` first: it holds the
approved permission matrix, job-order lifecycle and time definitions that
these phases implement.

Migration numbers continue from 004; the numbers below are suggestions,
so always take the next free one. Each migration gets a `.down.sql`,
uses only MariaDB 10.4 syntax, every statement is safe to re-run, and
existing data is never deleted or silently rewritten.

Size: S = a day or two of work, M = several days, L = a week or more.

---

## Phase 4: Equipment & asset register  (M)

**Goal:** one asset record per machine, mold and piece of plant equipment,
linked 1:1 to the existing `machines` and `molds` rows (never duplicated),
with a register, a detail page and maintenance state.

**Needs from owner first:** K-6 asset list (code, name, category, location)
and which categories really exist; K-8 answer (PM date correction).

**Database: `005_assets.sql`**
- `asset_categories` (id, name UNIQUE, is_active). Seed only the categories the owner confirms; at minimum "Injection molding machine" and "Mold".
- `assets`: id, `asset_code` UNIQUE, name, category_id FK, `machine_id` UNIQUE NULL FK machines, `mold_id` UNIQUE NULL FK molds, manufacturer, model, serial_no, location, owning_department, install_date, commission_date, `criticality` ENUM('A','B','C') default 'B', `maint_state` ENUM('operational','degraded','breakdown','under_maintenance','awaiting_parts','out_of_service','decommissioned') default 'operational', responsible_group, warranty_until DATE, specs TEXT, notes TEXT, decommissioned_at, created_at, updated_at. The service refuses an asset with both machine_id and mold_id set.
- Backfill: one asset per existing machine (asset_code = machines.code) and per mold (asset_code = molds.code), `INSERT … SELECT … WHERE NOT EXISTS`.
- `job_orders.asset_id` INT NULL FK + index. Backfill only exact, case-insensitive matches of `machine_name` to a machine's name or code; leave the rest NULL and list them on a "link job orders" screen. (Live data: "Vertical 1" and "Vertical Machine" match nothing, so a person links them.)
- `006_fix_pm_dates.sql` only if K-8 is confirmed: correct the two dates and write an `audit_log` row (source 'migration', reason quoting the owner's confirmation). `pm_completions` rows can be updated (no trigger on it).

**Backend**
- `src/services/assets.js`: create/update with audit; `changeState(conn, asset, to, {userId, reason})` with the allowed moves from DECISIONS.md (→ operational only via job closure or a verified release; → decommissioned only by Plant Mgr and only with no open job orders). Every state change writes `audit_log`.
- Keep assets in step with Production: when Production adds a machine or mold (`POST /production/machines`, `/production/molds`), create its asset row in the same transaction. Small, approved change; add a regression test.
- `src/routes/maintenance/assets.js` (or a section of `maintenance.js` if you prefer keeping one file per department).
- CSV export of the register (no new dependency; escape quotes). CSV import with a preview step, row-by-row validation, duplicate detection on asset_code and serial_no, and nothing written until the user confirms.

**UI**
- `/maintenance/assets`: register table with server-side search (code, name, serial), filters (category, state, criticality, location), sorting and pagination via query string (works without JavaScript). Empty state with "Add asset".
- `/maintenance/assets/:id`: overview, open job orders, maintenance history (job orders by asset), PM plans, downtime history (`downtime_logs` for its machine), state change with reason, audit trail.
- Production Machines page: link "Maintenance history" to the asset page (read-only for Production).
- Sidebar: Maintenance → "Equipment & Assets".

**Permissions to add:** `assets.view` (all maintenance viewers + production + toolroom), `assets.manage` (maintenance_manager), `assets.molds.manage` (toolroom, molds only), `assets.decommission` (plant_manager).

**Tests:** backfill is 1:1 and re-runnable; adding a machine creates exactly one asset; unique constraints; every state move allowed/refused per role; decommission refused with open jobs; import preview writes nothing, confirm writes valid rows only, duplicates reported; export honours permissions; Production regression unchanged; migration round trip on a copy of the dump.

**Acceptance:** every machine and mold has exactly one asset; register and detail pages show real data; the 2 legacy job orders can be linked from the UI; screenshots at 1440 and 820 px.

---

## Phase 5: Breakdown requests & work orders  (L, the core phase)

**Goal:** the full lifecycle from DECISIONS.md (Reported → … → Closed), with
triage, assignment history, labour, completion report, verification, holds,
reopen, and the K-2/K-3 rules.

**Database: `007_work_orders.sql`**
- `job_orders`: extend `status` ENUM with the new values (keep the old ones until the mapping has run, then a second statement narrows it), and add: `work_type` ENUM('breakdown','corrective','preventive','inspection','improvement','mold') default 'breakdown', `production_impact` ENUM('line_stopped','reduced_output','none'), `safety_flag` TINYINT, `safety_notes`, `observed_at` DATETIME, `machine_condition` ENUM('stopped','running_degraded','running'), `acknowledged_at`, `triaged_at`, `supervisor_id` FK users, `planned_start`, `planned_finish`, `actual_start`, `repair_completed_at`, `return_to_service_at`, `return_confirmed_by` FK users, `parent_job_order_id` FK (for follow-ups), `cancel_reason`, `row_version` INT NOT NULL DEFAULT 0.
- `job_order_assignments` (id, job_order_id, user_id, role ENUM('lead','helper'), assigned_by, assigned_at, ended_at, end_reason). Rows are only ever closed, never edited or deleted.
- `job_order_labor` (id, job_order_id, user_id, work_date, hours DECIMAL(5,2) 0–24, note, created_at).
- `job_order_completions` (id, job_order_id, completed_by, work_performed, failure_category, root_cause, corrective_action, technician_observations, created_at). A reopen adds a new row.
- `job_order_verifications` (id, job_order_id, verified_by, result ENUM('pass','reject'), reason, created_at).
- `maintenance_settings` new keys: verification rule, approval threshold, duplicate-report window (hours).
- Legacy status mapping per DECISIONS.md, run in the migration and tested on a copy of the live dump. Backfill `job_order_assignments` from `maintenance_actions`.

**Backend**
- Rewrite `src/services/workOrderState.js` MOVES for the new lifecycle: each move declares allowed from-states, the capability required, and its guard (reason required, verifier ≠ doer, row_version match). Keep `syncParts` (now moves between In progress and Waiting for parts). Keep the test that no other file writes `job_orders.status`.
- Optimistic concurrency: every action form posts `row_version`; a mismatch answers "This job changed since you opened it" and shows the current state without losing typed input.
- Asset state follows job events (report with machine stopped → breakdown; start → under_maintenance; waiting parts → awaiting_parts; close → operational).
- K-3: `POST /production/floor/:machineId/start` refuses when the machine's asset is `breakdown` or `out_of_service`, showing the open job order. Test it.
- Production create form: asset picker (required for new reports), production impact, observed/stopped time, machine condition, safety flag. Duplicate check: an open breakdown on the same asset is shown and the user must tick "this is a different failure" to continue.
- Production job order page: show resolution, and "Confirm machine back in production" (sets `return_to_service_at`) for jobs that stopped a machine.
- Update `statusLabels.js`, KPI queries (response = Reported→Acknowledged; MTTR = repair duration per DECISIONS.md) and the dashboard to the new statuses.
- Remove the transitional `jobs.accept` capability.

**UI**
- Maintenance → Breakdown Requests: new, open, critical, awaiting assignment, history.
- Maintenance → Work Orders: tabs All / Assigned to me / In progress / Waiting for parts / Waiting for approval / Awaiting verification / Closed; filters (asset, type, priority, assignee, date range); sorting; pagination.
- Work order page: header with status, priority, timers (response, repair duration, downtime), action bar showing only allowed moves, labour log, parts, completion report form, verification panel, timeline with from/to, reassignment history.
- Quick-view drawer from list rows (small vanilla JS in `public/js/app.js`, falling back to the full page link).
- Replace browser `confirm()` with a styled confirmation for consequential actions (cancel, close, reject, reopen).
- Tablet-friendly technician view (large touch targets) for start/hold/log labour/complete.

**Permissions to add:** `jobs.report`, `jobs.triage`, `jobs.assign`, `jobs.work.own`/`jobs.work.any` (keep), `jobs.verify`, `jobs.verify.critical` (plant_manager), `jobs.reopen`, `jobs.cancel`, `jobs.confirm_return` (production).

**Tests:** every move × every role (table-driven); verifier ≠ doer; Plant Mgr required for critical/safety; reopen keeps all history rows; cancel refused after start; duplicate warning; row_version conflict; K-3 block; timers from fixed timestamps; legacy mapping on the dump; directive end-to-end scenario steps 1–5 and 9–16 (parts approval waits for Phase 8).

**Acceptance:** the whole lifecycle works in the browser for each role; Production sees resolution and confirms return; KPIs use the new definitions; no regression in Production, Toolroom, Purchasing.

---

## Phase 6: Preventive maintenance engine  (L)

**Goal:** real recurring schedules that generate dated tasks idempotently,
with grace periods, non-working days, rescheduling, PM work orders and the
approved compliance formula.

**Database: `008_pm_engine.sql`**
- `pm_schedules` add: `asset_id` FK (backfill from machine_id via assets), `recurrence` ENUM('every_n_days','daily','weekly','monthly','yearly'), `interval_n` INT, `weekdays` SET('mon'…'sun'), `day_of_month` TINYINT, `month_of_year` TINYINT, `anchor_date`, `grace_days`, `non_working_rule` ENUM('keep','next_working','previous_working'), `lead_days` (when to release the work order), `estimated_minutes`, `priority`, `required_parts`, `required_tools`, `safety_instructions`, `default_assignee_id`. Existing rows become `every_n_days` with `interval_n = frequency_days` (behaviour unchanged).
- `pm_tasks` (id, pm_schedule_id, `original_due_date`, due_date, status ENUM('scheduled','due','overdue','released','completed_on_time','completed_late','cancelled','missed'), job_order_id, completed_at, completed_by, reschedule_reason, cancel_reason, created_at) with **UNIQUE(pm_schedule_id, original_due_date)**: this is what makes generation idempotent.
- `non_working_days` (date PK, reason).
- Copy existing `pm_completions` into `pm_tasks` as history (keep the old table).

**Backend**
- `src/services/pmScheduler.js`: pure functions, no database: `occurrences(rule, from, to)` with month-end clamping (monthly on the 31st → 28/29 Feb → 31 Mar, using the anchor day), leap years, and the non-working-day rule. Unit-test heavily.
- `scripts/generate-pm.js` (`npm run pm:generate`): creates tasks for the next 60 days with `INSERT IGNORE`, releases work orders `lead_days` before due, marks overdue/missed. Safe to run any number of times. Also run once at app start. Document Windows Task Scheduler setup.
- Plan edits affect only future tasks that aren't released yet; history stays.
- Compliance per DECISIONS.md, with numerator and denominator. This also fixes the current bug where a PM skipped before its due date counts as on time.

**UI:** Preventive Maintenance → PM plans (create/edit with recurrence builder and a preview of the next 5 dates), Due today, Upcoming, Overdue, History, Compliance report.

**Tests:** table-driven date rules (month ends, leap years, every weekday combination, non-working days); generator run twice creates nothing new; concurrent generator runs; edit → only future unreleased tasks change; compliance arithmetic including skips, late, cancelled; migration preserves current next-due dates.

---

## Phase 7: Inspections, safety & mold maintenance  (L)

**Database: `009_inspections.sql`**
- `checklist_templates` (id, name, asset_category_id NULL, is_active), `checklist_template_items` (id, template_id, step_no, text, `critical` TINYINT, result_type ENUM('pass_fail','measurement'), unit, min_value, max_value).
- `checklist_results` (id, job_order_id or pm_task_id, item text copied, result ENUM('pass','fail','na','not_inspected'), measured_value, comment, created_by, created_at).
- `job_orders` safety fields: `loto_required`, `isolation_verified_by`, `isolation_verified_at`, `permit_no`, `ppe` (text), `risk_notes`. The UI must state that a checkbox does not isolate energy and does not replace site procedures.
- `attachments` (id, entity, entity_id, original_name, stored_name, mime, size, uploaded_by, created_at). Needs one new dependency (`multer`): whitelist types (jpg, png, pdf), 10 MB limit, files stored outside `public/` and served by an authorised route; include the uploads folder in `scripts/backup.js`.
- Mold fields on `assets` (or `mold_details`): condition, release_status ENUM('available','in_service','needs_inspection','in_repair','quarantined'), service interval in shots and/or days (only if the owner supplies them), last_service_at.

**Backend/UI**
- Inspection templates (Maintenance Manager), results captured on work orders and PM tasks; a failed critical item escalates (notification in Phase 9) and offers a linked corrective work order.
- Mold & Tooling section for Toolroom: register view, inspections, repair requests, post-repair verification, release. Shot count = sum of `machine_opens` from `production_entries` since the last service, labelled "shots recorded in the system", never as lifetime shots.
- Ask the owner before blocking a mold change on Live Floor for an unreleased mold (it touches Production, like K-3).

**Tests:** template edits don't change past results; critical fail creates the escalation; upload type/size refused, files not reachable without login; shot count from fixture data.

---

## Phase 8: Spare parts & purchasing integration  (M)

**Database: `010_parts.sql`**
- `material_requests` add: `part_number`, `technical_description`, `manufacturer_equivalent`, `required_by` DATE, `reason`, `urgency`, `approver_id`, `approved_at`, `rejection_reason`; status ENUM gains `draft`, `awaiting_approval`, `approved`, `rejected`. Approved requests enter Toolroom's existing `pending` queue unchanged.
- `inventory` add `part_number` (UNIQUE NULL) and `location`.
- `parts_consumption` (id, job_order_id, inventory_id NULL, item_text, quantity, unit, recorded_by, created_at): what was actually used, separate from what was issued.
- `purchase_orders` add `expected_delivery`. Partial receipts are **not** supported today (a PO has one quantity); ask the owner before adding a `po_receipts` table.

**Backend/UI**
- Parts request form with the new fields; approval by Maintenance/Plant Manager above a Settings threshold; Toolroom matches stock by part number first, then name (fixes the typo-means-no-stock risk).
- Purchasing requisition/PO pages show the technical spec (read-only).
- Spare Parts menu: Mine, Awaiting approval, With Purchasing, Awaiting delivery (overdue expected_delivery highlighted), Available for issue.
- Consumption recorded at completion; inventory still only changes through Toolroom's issue/receive (no silent stock changes).

**Tests:** directive end-to-end scenario complete (steps 1–16); approval thresholds; matching by part number; no stock change without a Toolroom action; consumption vs issued.

---

## Phase 9: Dashboard, calendar, notifications, workload, search  (L)

- **Notifications** (`011_notifications.sql`): `notifications` (id, recipient_user_id NULL, recipient_role NULL, type, entity, entity_id, message, link, `dedupe_key` UNIQUE, created_at, read_at). Generated for: new breakdown, critical breakdown, high-priority unassigned for N minutes, PM due/overdue (from the generator), awaiting verification, parts awaiting approval, purchasing updates, delayed parts, reopened jobs, critical inspection failures. Bell with unread count in the top bar, list page, mark read. In-app only; refresh on page load plus optional 60 s polling. Never claim email/SMS/real-time.
- **Maintenance Overview** per the directive: critical-attention band, KPI row, equipment health distribution, breakdown/downtime trend, PM panel, work order queue, technician workload, parts shortages, recent activity, quick actions. Every number links to the filtered list behind it.
- **Calendar** (month / week / list, list is the accessible default on small screens): PM tasks, planned work orders, overdue items, planned shutdowns; filters by asset, type, priority, technician, department, status; event quick view. Drag-to-reschedule only if time allows, and only with permission check, reason and confirmation.
- **Technician Workload**: assignments, estimated vs logged hours, overdue, reassignment with audit. Don't present job counts as productivity.
- **Global search** in the top bar: JO number, asset code/name, PM plan, part number, filtered by permissions.
- Management dashboard: maintenance summary. Production dashboard: maintenance-downtime card from the same records.

---

## Phase 10: Reports & analytics  (M)

- `src/services/kpi.js`: one function per KPI, each documented with formula, source fields, date basis and exclusions, shown on screen as a tooltip with numerator and denominator: PM compliance, PM overdue, breakdown count, downtime, backlog, response time, MTTR, MTBF (operating time from `production_entries` ÷ qualifying failures; hidden below 2 failures), availability (planned time from `shifts` minus downtime; only where shift data exists), labour hours, cost (only if recorded), parts consumption, repeat failures (same asset + failure category within N days), workload, by category.
- Date range + comparison with the previous period; drill-down to records; print stylesheet; CSV export filtered by permissions (no new dependency).
- Investigate with the owner the 1875% achievement shown in Production Reports for IM-01 (target calculation when a run is mostly downtime). Do not change Production maths without approval.

---

## Phase 11: Security, performance, regression  (M)

- Authorisation test matrix generated from every route in the app × every role.
- Load a synthetic dataset (e.g. 50 machines, 50k job orders, 200k status log rows) into the test DB; `EXPLAIN` the slow queries; add indexes; confirm pagination everywhere.
- Remove N+1 queries (Live Floor loads assignment and run per machine).
- Optional: persistent sessions (`express-mysql-session`) so a restart doesn't log everyone out; rate-limit other POST endpoints; Content-Security-Policy header; `npm audit`.
- Run the full suite on MariaDB 10.4 on the host PC.

## Phase 12: Final acceptance  (M)

- Automated browser end-to-end test of the directive's 16-step scenario (Playwright against the test DB).
- Operator guide per role, deployment guide (running as a Windows service, backups, restore), rollback guide, final defect report.
