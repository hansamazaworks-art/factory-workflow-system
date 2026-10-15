# Factory Workflow System

> **Ongoing project: company management system.** A LAN web app that runs
> one injection-molding plant's day-to-day work. Production is complete;
> the **Maintenance module** is being built in 12 phases (Phases 1–3 done).
> Current status and what's next: [`docs/STATUS.md`](docs/STATUS.md) ·
> [`docs/ROADMAP.md`](docs/ROADMAP.md).
>
> Stack: Node.js, Express, EJS, MySQL/MariaDB.

Connects Production, Maintenance, Toolroom, Purchasing, and Management
on one flow: **Job Order → Accept → Request Tools/Materials → Check
Stock → Requisition (if needed) → Purchase Order → Management Approval**.

**Status: All 5 phases done, plus hardening — the full loop works
including receiving stock back into inventory. Production also now
has a full Floor Control module (see below).**
- **Production** creates Job Orders, and can cancel one before
  Maintenance accepts it. Production also runs Floor Control:
  machines, molds, operators, mold changes, production entry, downtime,
  reports and analytics — see "Floor Control" below.
- **Maintenance** accepts jobs and requests tools/materials.
- **Toolroom** checks stock, issues it, raises a purchase requisition
  when stock is short, and receives ordered stock back into inventory
  once it arrives. Toolroom also manages inventory directly.
- **Purchasing** turns open requisitions into Purchase Orders.
  Small purchases (under a configurable spending limit) are
  auto-approved; everything else goes to Management. Once approved,
  Purchasing marks a PO as ordered.
- **Management** reviews Purchase Orders above the spending limit and
  approves or rejects them, with optional remarks.
- **Everyone** can change their own password from the top bar.

Every step writes to the same job order's status history, so anyone
can open a job order and see the entire chain from creation to
final resolution in one timeline.

## Floor Control (Production role)

Alongside Job Orders, Production now has a full floor-control module,
under its own sidebar section:

- **Production Entry** — log a run (machine, shift, operator, opens,
  rejects, cycle time). Target opens are computed from cycle time and
  the run's available time (clock time minus any logged downtime that
  overlaps it), so achievement % reflects real machine availability.
- **Machines** — add machines and set their live status (running,
  idle, down, maintenance).
- **Molds** — tooling catalog: cavities and standard cycle time.
- **Operators** — floor personnel available for production entries.
- **Mold Changes** — assign a mold to a machine; this automatically
  closes out whatever was mounted before and keeps full history.
- **Downtime** — log stoppages by machine/date/shift/reason so they're
  excluded from target calculations.
- **Reports** — date-range summary per machine: gross/good pieces,
  reject %, achievement %, downtime minutes, plus downtime by reason.
- **Analytics** — last-7-days output vs. target chart and a downtime
  breakdown, both rendered server-side (no chart library / internet
  connection required — matches this app's offline-LAN design).

Run `db/schema.sql` to create the new tables (`shifts`, `machines`,
`molds`, `operators`, `mold_assignments`, `downtime_logs`,
`production_entries`) alongside the existing ones, then `npm run seed`
to get a couple of starter machines, molds and operators to test with.

## How this runs on your LAN (no internet/server needed)

Pick **one PC** to be the "host" — it runs this app and MySQL.
Every other PC just opens a web browser and types in the host's IP
address. Nothing gets installed on those other PCs.

```
[Host PC]                    [Other PCs on the same LAN/router]
 - Node.js app                       |
 - MySQL database      <-- browser --+--> http://192.168.x.x:3000
 - runs 24/7 or when needed           |
```

## One-time setup (on the host PC)

1. **Install Node.js** (v18 or newer) from nodejs.org.
2. **Install MySQL** (MySQL Community Server, or use XAMPP's MySQL) and
   make sure it's running.
3. **Unzip this project**, open a terminal in the folder, and run:
   ```
   npm install
   ```
4. **Create the database.** In MySQL Workbench, phpMyAdmin, or the
   `mysql` command line, run the contents of `db/schema.sql`. This
   creates the `factory_system` database and all tables.
5. **Configure your database password and spending limit.** Copy
   `.env.example` to `.env` and fill in your real MySQL password:
   ```
   cp .env.example .env
   ```
   While you're in there, set `AUTO_APPROVE_LIMIT` — purchase orders
   totaling less than this are approved automatically and skip
   Management's queue. Set it to `0` if you want Management to review
   every single purchase order regardless of amount. Check
   `COMPANY_TIMEZONE` too (default `Asia/Manila`): every date the app
   shows, compares or stores uses it.
6. **Bring the database up to date** (adds everything from later
   phases to the tables `db/schema.sql` created):
   ```
   npm run migrate
   ```
7. **Create starter logins** (one per role, password `password123`):
   ```
   npm run seed
   ```
   Change these passwords before real use — this is just for testing.
   For real people, use `npm run user` (see "Accounts and roles").
8. **Start the app:**
   ```
   npm start
   ```
   You'll see something like:
   ```
   Factory system running.
   - On this PC:   http://localhost:3000
   - On the LAN:   http://<this-PC's-IP-address>:3000
   ```

## Finding the host PC's LAN IP address

- **Windows:** open Command Prompt, run `ipconfig`, look for "IPv4 Address" (e.g. `192.168.1.15`).
- **Mac/Linux:** run `ifconfig` or `ip addr`, look for something like `192.168.1.15`.

Every other computer on the same Wi-Fi/router can now go to
`http://192.168.1.15:3000` (using your actual IP) and log in.

> **Windows Firewall note:** the first time, Windows may ask to allow
> Node.js through the firewall for private networks — click Allow, or
> other PCs won't be able to reach it.

## Test logins (after running `npm run seed`)

| Username | Role | Password |
|---|---|---|
| prod1 | Production | password123 |
| maint1 | Maintenance | password123 |
| tool1 | Toolroom | password123 |
| purch1 | Purchasing | password123 |
| boss1 | Management | password123 |
| mmgr1 | Maintenance Manager | password123 |
| plant1 | Plant Manager | password123 |

**First login:** anyone who signs in with the starter password
`password123` is taken straight to *Change Password* and cannot use
any other page until they choose their own. The starter password can
never be chosen again. After 5 wrong passwords for the same username
from the same computer, that username is locked for 15 minutes.

## Try the full flow end to end

1. Log in as `tool1` first and add a couple of inventory items under
   **Manage Inventory** (e.g. "Hydraulic hose fitting 1/2in", qty 10).
2. Log in as `prod1`, create a job order.
   - Try **Cancel Job Order** on it while it's still "pending" — then
     create a fresh one to continue the walkthrough with, since a
     cancelled job order is a dead end.
3. Log in as `maint1` — accept the job order, then request tools/
   materials using an item name that **doesn't** match inventory (so
   it triggers a requisition — the more interesting path to test).
4. Log in as `tool1` — the request appears on the dashboard. Click
   **Check**, then **No Stock - Raise Purchase Requisition**.
5. Log in as `purch1` — the requisition appears under "Open
   Requisitions". Click **Create PO**, enter a supplier and a unit
   price.
   - If the total comes out **under** your `AUTO_APPROVE_LIMIT`, the
     PO is approved instantly — skip to step 7.
   - If it's **at or above** the limit, it goes to Management first —
     continue to step 6.
6. Log in as `boss1` — the PO appears under "Purchase Orders Pending
   Approval". Click **Review**, add optional remarks, and click
   **Approve** or **Reject**.
7. Log back in as `purch1`, open the (now approved) PO, and click
   **Mark as Ordered** — this is you confirming you've actually placed
   the order with the supplier.
8. Log in as `tool1` — the PO now shows under "Purchase Orders
   Awaiting Receipt". Click **Review**, then **Mark Received** — this
   adds the stock to inventory and drops the original request back
   into your queue.
9. Still as `tool1`, find that request again in "Material Requests"
   and click **Issue from Stock** — now that stock exists, it goes
   through normally.
10. Log back in as `prod1` or `maint1` and open the job order — the
    status history shows every step, start to finish: created,
    accepted, tools requested, no stock, PO created, approved,
    ordered, received, and finally issued.

Anyone can also click **Change Password** in the top bar at any time.

## Project layout

```
factory-system/
├── CLAUDE.md             <- instructions Claude Code reads every session
├── .claude/skills/       <- /run-phase command for Claude Code
├── docs/
│   ├── STATUS.md         <- where the project stands, what's missing
│   ├── ROADMAP.md        <- detailed plan, Phases 4-12
│   └── DECISIONS.md      <- approved permissions, workflows, owner decisions
├── test/                 <- automated tests (npm test)
├── db/
│   ├── schema.sql        <- base database design (new installs: run first)
│   ├── migrations/       <- numbered changes since then (npm run migrate)
│   └── seed.js           <- creates test logins
├── scripts/
│   ├── backup.js         <- database backup (npm run backup)
│   ├── migrate.js        <- apply / undo migrations (npm run migrate)
│   └── user.js           <- create accounts, change roles (npm run user)
├── backups/              <- backup files land here (gitignored)
├── src/
│   ├── server.js         <- app entry point
│   ├── app.js            <- the app itself (security, sessions, routes)
│   ├── config/           <- MySQL connection, company time zone
│   ├── middleware/       <- login + permission checks, CSRF, login limiter
│   ├── constants/
│   │   ├── permissions.js<- who may do what (the one place)
│   │   └── statusLabels.js <- shared status text, used by all modules
│   ├── services/
│   │   ├── workOrderState.js <- the only code that changes a job order's status
│   │   ├── audit.js      <- append-only change history
│   │   ├── settings.js   <- Maintenance Settings
│   │   └── users.js      <- account administration
│   ├── utils/dates.js    <- calendar dates in the company time zone
│   └── routes/
│       ├── auth.js       <- login/logout
│       ├── account.js    <- change password (any role)
│       ├── production.js <- floor control; create, view, cancel job orders
│       ├── maintenance.js<- accept jobs, request materials, KPIs, PM, settings
│       ├── toolroom.js   <- check stock, issue, raise requisitions, receive POs
│       ├── purchasing.js <- create POs, auto-approval, mark as ordered
│       └── management.js <- approve or reject purchase orders
├── views/                <- pages (EJS templates)
└── public/               <- styling, fonts, app.js (sidebar, toasts)
```

## Backups

Everything lives in one MySQL database on the host PC, so back it up
regularly.

**Run manually:**
```
npm run backup
```
This writes a timestamped `.sql` file into the `backups/` folder using
`mysqldump` (installed alongside MySQL), and automatically keeps only
the most recent 30 backups so the folder doesn't grow forever. It
needs `mysqldump` to be on your system PATH — if you installed MySQL
normally, it usually already is.

**Schedule it automatically:**

- **Windows (Task Scheduler):**
  1. Open Task Scheduler → Create Basic Task.
  2. Trigger: Daily, at whatever time the host PC is reliably on.
  3. Action: "Start a program" →
     - Program/script: `node`
     - Arguments: `scripts/backup.js`
     - Start in: the full path to your `factory-system` folder
       (e.g. `C:\Users\YourName\factory-system`)
  4. Finish. Test it once with "Run" in Task Scheduler to confirm a
     new file appears in `backups/`.

- **Mac/Linux (cron):** run `crontab -e` and add a line like:
  ```
  0 2 * * * cd /path/to/factory-system && /usr/bin/npm run backup
  ```
  This runs it every day at 2 AM. Adjust the path and time as needed.

To restore a backup, import the `.sql` file the same way you imported
`db/schema.sql` originally.

## Upgrading an existing installation

Every update that changes the database comes with numbered files in
`db/migrations`. After unzipping a new version (and copying your `.env`
into it), run once:

```
npm run migrate            # takes a backup, then applies what's new
npm run migrate -- status  # shows which migrations are applied
npm run migrate -- down    # takes a backup, then undoes the latest one
```

`npm run migrate` refuses to change anything if the backup fails. If
`mysqldump` isn't on this PC's PATH, take a backup in phpMyAdmin
(*Export*) and run `npm run migrate -- --no-backup`. Each statement is
safe to re-run, so if a migration stops halfway you fix the cause and
run the same command again.

Some tables only ever grow: `job_order_status_log` (every job order's
timeline) and `audit_log` (settings and account changes). The database
itself refuses to edit or delete their rows, including from phpMyAdmin.

## Accounts and roles

Create and manage real accounts from a terminal on the host PC:

```
npm run user -- list
npm run user -- add jdelacruz "Juan Dela Cruz" maintenance_manager "Maintenance"
npm run user -- role msantos plant_manager "Promoted 1 Nov"
npm run user -- deactivate preyes "Left the company"
npm run user -- activate preyes
npm run user -- reset-password msantos "Forgot password"
```

New accounts and reset passwords get the starter password
`password123`; the person must choose their own at first login. Role
changes and deactivations apply on the person's next click, and every
change is recorded in `audit_log`.

| Role | Who | Sees |
|---|---|---|
| `production` | Production Managers | Production |
| `maintenance` | Maintenance Technicians | Maintenance: accept jobs, request parts, complete own jobs, log PMs |
| `maintenance_manager` | Maintenance Manager | Maintenance: everything, including PM schedules and Settings |
| `plant_manager` | Plant Manager | Maintenance, read-only for now (approvals arrive in Phase 5) |
| `toolroom` | Tool Room | Toolroom |
| `purchasing` | Purchasing Managers | Purchasing |
| `management` | Company Management | Management, plus Maintenance read-only |
| `admin` | System administrator | Everything |

The full list of who may do what is in `src/constants/permissions.js`.

## Running the automated tests

The project has a regression suite (Node's built-in test runner plus
`supertest`). It checks that every page loads for its role, the Live
Floor cycle, the full Production → Maintenance → Toolroom →
Purchasing → Management chain, and the security fixes.

The tests build their own throwaway database called
`factory_system_test` (they refuse to run against any name that does
not end in `_test`), so your real data is never touched.

```
npm install          # once, installs the test tools too
npm test             # all test files
npm test -- 03       # only files whose name contains "03"
```

By default the tests use the `DB_HOST`, `DB_USER` and `DB_PASSWORD`
from `.env`. To use a separate MySQL account, set `TEST_DB_HOST`,
`TEST_DB_USER` and `TEST_DB_PASSWORD` first. The account needs
permission to create and drop the `factory_system_test` database.

## Security and reliability (Phase 2)

- **The server no longer crashes on a database error.** Any error in
  a page shows a plain "Something went wrong" page; details go to the
  server console only, never to the browser.
- **Forms are protected against forgery (CSRF).** Every form carries a
  hidden token; a submission without it is refused. If someone sees
  "This form was out of date", they reload the page and try again.
- **Session cookie** is `HttpOnly` and `SameSite=Lax`, and a fresh
  session is issued at every login. If you ever serve the app over
  https, set `COOKIE_SECURE=true` in `.env`.
- **Only the technician who accepted a job order** can request
  materials for it or mark it completed, and only while it is open.
- **Fonts are served from this app**, so pages look the same with no
  internet connection.

## What's hardened, and what's still a judgment call

Implemented in this pass:
- **Password changes** — any role can change their own password from
  the top bar. The `npm run seed` passwords should still be replaced
  before real use.
- **Spending limits** — `AUTO_APPROVE_LIMIT` in `.env` lets small
  purchase orders skip Management's queue automatically; anything at
  or above it still needs a human decision.
- **Receiving** — a full Ordered → Received step closes the loop:
  Purchasing marks a PO ordered, Toolroom marks it received (which
  restocks inventory), and the original request drops back into
  Toolroom's normal queue to be issued.
- **Cancelling** — Production can cancel a job order, but only before
  Maintenance accepts it. This keeps the audit trail meaningful: once
  someone has started acting on a job, cancelling silently would hide
  that work.
- **Backups** — a script plus scheduling instructions above.

Deliberately left alone, worth a decision before scaling up:
- **Editing** submitted data (job orders, requests, POs) is still not
  possible — only cancellation of an unstarted job order. If people
  make typos often, you may want an edit history feature; for now,
  the assumption is that role-based checks downstream (a foreman
  clarifying with maintenance, a supplier confirming a quote) catch
  mistakes before money moves.
- **Spending limit tiers** — there's currently one global auto-approval
  threshold, not different limits per person or role (e.g. a
  purchasing lead vs. a junior buyer). If you need that, it would mean
  adding a `spending_limit` column to `users` and checking it against
  the individual who's creating the PO.
- **Cancelling further down the chain** (a maintenance job, a
  requisition, a PO) isn't supported — once Maintenance accepts a job
  or Toolroom raises a requisition, it has to run its course. Worth
  revisiting if false starts turn out to be common in practice.
