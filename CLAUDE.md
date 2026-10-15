# Factory Workflow System

LAN web app for one injection-molding plant: Production → Maintenance →
Toolroom → Purchasing → Management, all around the **job order**. Runs on
one Windows host PC (XAMPP, MariaDB 10.4.32); other PCs use a browser.
We are building the **Maintenance module** in 12 phases. Phases 1–3 are
done; Phase 3 awaits the owner's approval.

**Start of every session:** read `docs/STATUS.md` (where things stand and
what's missing). Before building, read `docs/ROADMAP.md` (the phase plan)
and `docs/DECISIONS.md` (approved permission matrix, job-order lifecycle,
time definitions). Run the phase workflow with `/run-phase <number>`.

## Commands

```
npm install
npm start                      # http://localhost:3000
npm test                       # all test files; npm test -- 07 runs one
npm run migrate                # backup, then apply pending migrations
npm run migrate -- status      # list migrations
npm run migrate -- down        # backup, then undo the latest
npm run user -- list           # accounts: add / role / deactivate / activate / reset-password
npm run seed                   # test logins (password123, must be changed at first login)
npm run backup                 # mysqldump into backups/
```

Tests build and drop their own database `factory_system_test` (the name must
end in `_test`; they refuse otherwise) from `db/schema.sql` + migrations.
They use `DB_*` from `.env`, or `TEST_DB_HOST`, `TEST_DB_USER`,
`TEST_DB_PASSWORD` if set. That account needs rights on `factory_system_test`.
**Never point tests or experiments at the real `factory_system` database.**
To try something on real data, import a dump into a scratch database.

## Stack

Node 18+ (CommonJS), Express 4, EJS server-rendered pages, `mysql2/promise`
with raw parameterised SQL (no ORM), `express-session` (memory store),
bcryptjs, one stylesheet `public/css/style.css`, a small vanilla
`public/js/app.js`. Tests: Node's built-in `node:test` + `supertest`.
No CDN or internet at runtime: fonts are local, charts are HTML/CSS.

## Map

- `src/app.js` builds the app (session, CSRF, account refresh, routes, error page); `src/server.js` starts it.
- `src/routes/<department>.js`: one router per department, created with `require('../utils/asyncRouter')()`.
- `src/constants/permissions.js`: **the** permission matrix (capability → roles). `requirePermission('cap')` on routes, `can('cap')` in views.
- `src/services/workOrderState.js`: **the only code that may change `job_orders.status`** (a test enforces it).
- `src/services/audit.js` (append-only `audit_log`), `settings.js`, `users.js`.
- `src/utils/dates.js` + `src/config/timezone.js`: company time zone (Asia/Manila).
- `src/db/migrator.js`, `scripts/migrate.js`, `db/migrations/NNN_name.sql` + `NNN_name.down.sql`.
- `views/partials/header.ejs` builds the sidebar and breadcrumbs from the permission list.
- `test/NN-*.test.js`, helpers in `test/helpers/` (`login(app, 'mmgr1')` gives a logged-in agent whose `.post` adds the CSRF token).

## Conventions (follow these)

- **Permissions:** add capabilities to `permissions.js`; never check role names in routes or views. Every route that changes data has its own `requirePermission`. Hide controls the user can't use, and still enforce on the server.
- **Job order status:** call `state.move(...)` / `state.syncParts(...)` inside the route's transaction. Never `UPDATE job_orders SET status` anywhere else.
- **Writes:** `pool.getConnection()` → `beginTransaction()` → `SELECT … FOR UPDATE` the row → validate the current state → write → `commit()`; `rollback()` in `catch`, `release()` in `finally`. Unknown id → 404, not allowed → 403.
- **Dates:** a calendar day is a `YYYY-MM-DD` string in the company time zone: `dates.today()`, `dates.ymd(value)`, `dates.addDays()`. **Never use `toISOString()` for a date** (it is UTC and caused real bugs). In views use `ymd(...)`.
- **Migrations:** next free number; MariaDB 10.4 syntax; every statement safe to re-run (`IF NOT EXISTS`, `INSERT IGNORE`); always a `.down.sql`; put the riskiest statement of a rollback first; never drop or rewrite existing data silently; test up → down → up on a copy of the live dump. `db/schema.sql` is the base for new installs; don't edit its tables, add migrations.
- **History is append-only:** `audit_log` and `job_order_status_log` reject UPDATE/DELETE at DB level. Record important changes (who, old, new, reason) with `audit.record`.
- **Forms:** CSRF tokens are added to every `<form method="POST">` automatically. On a validation error, re-render with status 400, keep what the user typed, and show the message next to the field. On success, `req.flash('success', …)` then redirect (it shows as a toast).
- **UI:** reuse the design tokens on `:root` in `style.css` (navy accent, status colours that pass WCAG AA). Page = `.content-header` + `.card`s. Tables and lists must work without JavaScript (filters, sort and paging via query string). Check every UI change in a browser at 1440 px and 820 px.
- **Dependencies:** don't add frameworks. A new npm package needs a reason in the phase report.

## Hard rules (from the owner's directive)

1. Work one phase at a time. Finish, test, report, and **wait for the owner's approval** before the next phase.
2. **Never break Production.** Production behaviour changes only with explicit approval (approved so far: K-3, K-4). Re-run `npm test` and compare Production pages before and after on a copy of the live dump.
3. Never claim something is implemented, tested or verified unless you did it. Say "not executed" when you didn't run it.
4. Never fabricate data: no invented machines, schedules or KPIs shown as real. Test data must be clearly labelled.
5. Never commit or print `.env` values or other secrets.
6. Don't hardcode statistics, and no buttons, links or filters that do nothing.
7. Keep the app runnable after every change; prefer small, reviewable changes.

## Definition of done (each feature)

UI built and checked in a browser · backend persists it · migration with
rollback · permissions enforced and tested · inputs validated · empty,
error and success states · tests added and passing · no Production
regression · README/docs updated · phase report states real test results.

## Phase report format

Scope and acceptance criteria (met / not met, with evidence) · files
created/changed · database changes and rollback · tests run and actual
results · known limitations · decisions needed from the owner · install
and verify steps for the host PC · "ready for review: yes/no". Keep
`docs/STATUS.md` up to date at the end of each phase.

The owner is not a developer: explain in plain words, with clear steps.
