# Approved design decisions

Approved by the owner during Phases 1–3 (October 2026). Treat these as
requirements. Changing one needs the owner's approval first.

## Owner decisions (K-1 … K-9)

| # | Decision | Status |
|---|---|---|
| K-1 | A **job order** stays the single record from breakdown report to closure. No separate work-order table: Toolroom, Purchasing and Production keep the same IDs and JO numbers. | Approved |
| K-2 | **Maintenance Manager** verifies and closes work. **Plant Manager** also signs off Critical and safety-flagged jobs. The verifier may never be the person who did the work. | Approved, build in Phase 5 |
| K-3 | **Live Floor refuses to start a run** while the machine's asset is in `breakdown` or `out_of_service`, and shows the reason. The only behaviour change to Production that was approved. | Approved, build in Phase 5 |
| K-4 | Company time zone **Asia/Manila** (`COMPANY_TIMEZONE` in `.env`; Asia/Singapore is the same UTC+08:00). The UTC "today" bugs are fixed. | Done in Phase 3 |
| K-5 | Maintenance **technicians get their own logins** (role `maintenance`). | Done in Phase 3 |
| K-6 | Owner to supply the **real user list and asset list** (code, name, category, location). Until then use only clearly labelled test data. | **Waiting on owner** |
| K-7 | Owner rotates the DB password and session secret; the app uses its own DB account, not `root`. | Owner's action |
| K-8 | "Fix bolts" PM was saved by the old date bug: completion due `2026-08-31` (probably `2026-09-01`), next due `2026-10-09` (should be `2026-10-10`). Correct only if the owner confirms 1 Sep was entered; do it as an audited migration. | **Waiting on owner** |
| K-9 | The real Maintenance Manager gets their own account rather than promoting the shared `maint1` test login. | Recommended |

## Roles

`users.role` values (migration 003). Never replace the login system.

| Role | Person | Home page |
|---|---|---|
| `production` | Production Managers (2) | /production/dashboard |
| `maintenance` | Maintenance Technicians | /maintenance/dashboard |
| `maintenance_manager` | Maintenance Manager (1) | /maintenance/dashboard |
| `plant_manager` | Plant Manager (Mechanical Engineer) | /maintenance/kpi |
| `toolroom` | Tool Room (2) | /toolroom/dashboard |
| `purchasing` | Purchasing Managers (2) | /purchasing/dashboard |
| `management` | Company Management | /management/dashboard |
| `admin` | System administrator | /production/dashboard |

## Permission matrix (target; Phase 3 implemented the rows marked ✔)

Full = create/change · Own = only records assigned to or raised by them ·
View = read only · blank = no access. Capabilities live in
`src/constants/permissions.js`; add new ones there, never check role names in routes.

| Capability | Mgmt | Plant Mgr | Maint Mgr | Technician | Production | Purchasing | Toolroom |
|---|---|---|---|---|---|---|---|
| ✔ Maintenance dashboards and KPIs | View | View | Full | View | View (own machines' downtime, Phase 9) | | |
| Asset register | View | View | Full | View | View | | View (molds: Full) |
| Report a breakdown | | Full | Full | Full | Full | | Full (molds) |
| Acknowledge, triage, prioritise | | Full | Full | | | | |
| Assign / reassign | | Full | Full | | | | |
| ✔(partly) Start, hold, log labour, request parts | | | Full | Own | | | Own (mold jobs) |
| ✔(partly) Submit completion | | | Full | Own | | | Own (mold jobs) |
| Verify, reject, close | | Full | Full | | Confirm return to production | | Mold release |
| Reopen with reason | | Full | Full | | Full (own requests) | | |
| Approve parts requests | | Full | Full | | | | |
| Purchasing chain | Approve over limit | | | | | Full (unchanged) | Full (unchanged) |
| ✔ PM plans and Settings | View | View | Full | View | | | Full (mold PM) |
| Reports and exports | Full | Full | Full | | View | | |
| Audit history | View | View | View | | | | |

Transitional (Phase 3 → 5): `jobs.accept` lets technicians take a job from
the queue themselves. Phase 5 replaces it with manager triage and assignment.

## Job order lifecycle (target, built in Phase 5)

Reported → Acknowledged → Triaged → Assigned → In progress →
Repair completed → Awaiting verification → Closed.
Pauses that return to In progress: On hold (reason required), Waiting for
parts (set when Toolroom has no stock), Waiting for approval (Plant Manager
sign-off; may also follow Triaged). Cancel: only before work starts, reason
required. Reject at verification → back to In progress. Reopen from Closed
→ Assigned, with reason. Jobs that need no verification close from Repair
completed (Maintenance Manager only).

| From | To | Who | Guard |
|---|---|---|---|
| — | Reported | Production, Toolroom, Maint, Plant Mgr | Asset required; observed time ≤ now; if the asset already has an open breakdown, show it and ask "same failure?" |
| Reported | Acknowledged | Maint Mgr, Plant Mgr | Stamps response time |
| Acknowledged | Triaged | Maint Mgr, Plant Mgr | Priority + work type confirmed; safety flag forces Critical and notifies Plant Mgr |
| Triaged | Assigned | Maint Mgr, Plant Mgr | At least one technician |
| Assigned / On hold | In progress | Assignee | First start stamps actual start |
| In progress | On hold | Assignee, Maint Mgr | Reason required |
| In progress | Waiting for parts | System (Toolroom "no stock") | Back to In progress when all the job's parts are issued |
| Triaged / In progress | Waiting for approval | Maint Mgr | Cost/scope over the Settings threshold |
| In progress | Repair completed | Assignee | Work done + corrective action; failure cause + root cause for breakdown/corrective |
| Repair completed | Awaiting verification | System | When the verification rule applies |
| Awaiting verification | Closed | Verifier ≠ doer | Pass; Production confirms return-to-production time for stopped machines |
| Awaiting verification | In progress | Verifier | Reject with reason |
| Reported → Assigned | Cancelled | Raiser or Maint Mgr | Reason; not after work started |
| Closed | Assigned | Maint Mgr, Plant Mgr, raiser | Reopen with reason; history kept |

**Legacy mapping (migration in Phase 5):** `pending` → Reported,
`accepted` → Assigned, `tool_requested`/`checking_stock`/`ready_to_issue`/`issued`
→ In progress, `awaiting_purchase` → Waiting for parts, `in_progress` → In progress,
`completed` → Closed (marked "closed before verification existed"), `cancelled` → Cancelled.
On the live data: JO-2026-0001 → Waiting for parts, JO-2026-0002 → Reported
(or Assigned if it has been accepted since).

## Who owns which status

| Status | Owner | Rule |
|---|---|---|
| `machines.status` (running/idle/down/maintenance) | Production (Live Floor) | Maintenance never writes it |
| `assets.maint_state` (operational, degraded, breakdown, under_maintenance, awaiting_parts, out_of_service, decommissioned) | Maintenance | Driven by job order events, plus manual moves with a reason |
| `material_requests.status` | Toolroom | Parts state lives here, not on the job order |
| `purchase_orders.status` | Purchasing | Unchanged |
| `job_orders.status` | `src/services/workOrderState.js` only | A test fails if any other file writes it |

## Time definitions (never mix them)

- **Response time** = Reported → Acknowledged.
- **Repair duration** = actual start → Repair completed, excluding On hold and Waiting for parts (reported separately).
- **Production downtime** = machine stop (observed) time → return-to-production time confirmed by Production. Not the same as repair duration.

## PM task lifecycle (Phase 6)

Scheduled → Due (on the due date) → Overdue (after due + grace). Released
when its work order is created. Ends as **Completed on time**, **Completed
late**, **Cancelled** (approved, reason, excluded from compliance) or
**Missed** (closed out, non-compliant). Rescheduling keeps the original due
date for compliance and records the reason.

PM Compliance (%) = eligible PM tasks completed on time (within grace) in the
period ÷ eligible PM tasks due in the period × 100. Show numerator and
denominator. Skipped/missed count against compliance; approved cancellations
are excluded.

## Changes to the Phase 1 plan (approved implicitly with Phase 3)

1. The job-order status vocabulary switch moved from Phase 3 to **Phase 5**,
   together with the screens that use it.
2. Tables for later features (assets, PM tasks, checklists, notifications,
   attachments) are created **in the phase that uses them**, not ahead of time.
