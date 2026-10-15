# Project status: 12 October 2026

**Where it stands:** Phases 1–3 of 12 are done; Phase 3 is waiting for the
owner's review. 104 of 104 automated tests pass. The Maintenance module so
far is a foundation (safety, roles, permissions, audit, dates, settings);
most of the directive's maintenance features are still to build (Phases 4–12).

Full phase reports (Phase 1 audit & plan, Phase 2 and Phase 3 reports) are in
the owner's document "Maintenance Module — Plan & Phase Reports" on claude.ai.
This file is the self-contained summary for work in Claude Code.

## Done

| Phase | What | Result |
|---|---|---|
| 1 Audit & plan | Read every file and the live DB dump; architecture, gaps, permission matrix, workflows, risks, 12-phase plan | Approved with all recommendations |
| 2 Shell & safety | Crash-safe routes; CSRF on every form; secure cookie; login lockout (5 tries / 15 min); forced change of the starter password; completion guard; navy collapsible sidebar, mobile drawer, breadcrumbs, focus rings, WCAG AA contrast, toasts, offline fonts; first regression suite | Approved. 49 tests. Found and fixed: Toolroom compared stock quantities as text |
| 3 Database & authorisation | Migration runner with backup and rollback; roles `maintenance_manager`, `plant_manager`; permission matrix in one file, checked on the server; per-request account check; append-only `audit_log` and status log (DB triggers); job-order state service; company time zone; Maintenance Settings; `npm run user` | **Waiting for approval.** 104 tests. Fixed 4 original bugs (below) |

**Bugs found in the original code and fixed (with tests):** PM due dates
drifted a day early on every completion (already in the live data, see K-8);
Analytics showed today's output on yesterday's bar; before 08:00 Reports and
the Downtime form defaulted to yesterday; a completed job reopened when the
Toolroom issued a leftover part; Toolroom compared stock as text (could issue
more than in stock); literal `&middot;` on machine cards; raw status codes on
the KPI table.

**Verified on a copy of the live database (9 Oct dump):** the Phase 3
upgrade keeps every existing row unchanged; all 12 Production pages show the
same content as the original code; rollback and re-apply round-trip cleanly.

**Not verified yet:** MariaDB 10.4.32 (the owner's version; tests ran on
10.11), the owner's host PC, a physical tablet, a screen reader. Phases 2–3
have not been confirmed installed on the host PC.

## What's lacking, against the directive

| Directive section | Exists today | Missing | Phase |
|---|---|---|---|
| 02 Roles | 8 roles, server-side permission checks | Plant Manager approvals/sign-off; Production confirming return to service; Tool Room mold work; Purchasing seeing part specs | 5, 7, 8 |
| 03 UI/UX | Navy collapsible sidebar, drawer, breadcrumbs, focus, contrast, toasts, read-only styling | Global search, notification centre, quick-view drawers, sortable/paginated tables, filters/date ranges, saved filters, bulk actions, styled confirm dialogs (still `confirm()`), tooltips on metrics, loading/skeleton states, unsaved-change warnings, inline validation beyond Settings/parts | 4–9 |
| 04 Navigation | Dashboard, KPI, PM Schedule, Maintenance Settings | Equipment & Assets, Breakdown Requests, Work Orders, Inspection Checklists, Mold & Tooling, Spare Parts, Technician Workload, Calendar, Reports | 4–10 |
| 05 Assets | 3 `machines`, 2 `molds` (Production tables) | Whole asset register: categories, criticality, maintenance state, specs, warranty, documents, history, import/export | 4 |
| 06 Production integration | Job orders raised by Production; Live Floor; downtime logs | Job orders linked to a machine (free-text name today); severity/impact/observed time; duplicate-report check; return-to-service confirmation; K-3 Live Floor block; maintenance downtime on Production dashboard | 4, 5, 9 |
| 07 Breakdown requests | Create → accept → materials → complete | Acknowledge, triage, assign, safety escalation, cancel/reopen with reason, response/repair timers | 5 |
| 08 Work orders | One acceptor, parts requests, complete | Work types, assignment history, labour hours, holds, completion report (cause, root cause, action), verification/rejection, planned dates, costs, row-version conflicts | 5 |
| 09 PM engine | Interval-in-days schedules, mark done/skip, overdue flag | Daily/weekly/monthly/yearly rules, generated tasks (idempotent), grace periods, non-working days, rescheduling with reason, PM work orders, checklists, parts/tools/safety per plan, compliance per the approved formula | 6, 7 |
| 10 Calendar | — | Month/week/list calendar, filters, quick view | 9 |
| 11 Inspections & safety | — | Templates, pass/fail/N/A/not inspected, measurements, LOTO/permits/PPE fields, critical-fail escalation | 7 |
| 12 Molds | Mold catalogue and mounting history (Production) | Condition, release status, shot-based service, inspections, repair records | 7 |
| 13 Parts & purchasing | Request → Toolroom → requisition → PO → approval → order → receive → issue | Part numbers, specs, approval step, required date, matching by part number, consumption record, expected delivery, partial receipts | 8 |
| 14 Workload | — | Workload view, reassignment, conflicts | 9 |
| 15 Analytics | KPI page: open/overdue jobs, response, accept→complete time, completions per day, PM overdue/compliance | MTBF, availability, downtime, labour, cost, consumption, repeat failures, per category, date ranges, comparisons, drill-down, print, CSV export; documented formulas | 10 |
| 16 Notifications | Toasts only | Notification table, bell, unread, dedupe, escalations | 9 |
| 17 Data | `audit_log`, `maintenance_settings`, status log with from/to | assets, assignments, labour, completions, verifications, PM tasks, checklists, parts consumption, notifications, attachments, non-working days | 4–9 |
| 18 Security | CSRF, login lockout, server-side authorisation, parameterised SQL, crash-safe errors, security headers | File-upload handling, pagination of large lists, persistent sessions, rate limits beyond login, CSP | 7, 11 |
| 19 Performance | — | Pagination, index review on a large dataset, N+1 removal on Live Floor | 11 |
| 20 Audit | Status log (from/to, append-only), settings and account changes | Priority changes, asset state changes, PM plan changes, approvals, reassignments | 4–8 |
| 21 Testing | 104 tests: access, Live Floor, job-order chain, safety, shell, migrations, permissions, state, settings/users, dates | Browser end-to-end tests, accessibility checks, load tests, MariaDB 10.4 run | 11–12 |

## Open issues and data problems

- **K-8, live data:** "Fix bolts" PM has a completion due date of 2026-08-31 and a next due date of 2026-10-09, written by the old date bug. They are probably meant to be 2026-09-01 and 2026-10-10.
- **Live data:** both job orders name machines that don't exist ("Vertical 1", "Vertical Machine"; the register has "Injection Molder #1–3"). Material request #1 has quantity 2, unit "4" (looks swapped).
- **Live data:** all 5 accounts still use the starter password; they will be forced to change it at next login.
- **Production Reports** show 1875% achievement for IM-01 on 10 Sep (target maths when a run is mostly downtime). Not changed; to review with the owner in Phase 10.
- **PM Compliance** counts a PM skipped before its due date as "on time". Left as is; Phase 6 replaces the formula.
- **Behaviour changes the owner should know about:** technicians can no longer create or pause PM schedules (Maintenance Manager only); a job stays "Waiting on Purchase Order" until all its parts are in; Management can now see Maintenance pages.
- **Environment:** the append-only triggers can fail to install if MariaDB's binary log is on (off by default). The app assumes the host PC clock is on UTC+08:00, and each database connection is set to +08:00 regardless.
- No persistent sessions: restarting the app logs everyone out.

## Decisions waiting on the owner

K-6 (real user and asset lists), K-8 (PM date correction), K-9 (who the
Maintenance Manager is), and Phase 3 approval. See `docs/DECISIONS.md`.
