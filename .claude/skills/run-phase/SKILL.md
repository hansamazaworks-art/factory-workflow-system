---
name: run-phase
description: Build one phase of the Maintenance module roadmap end to end (plan, build, test, verify, report). Use when the owner asks to start or continue a phase, e.g. /run-phase 4.
---

Build Phase $ARGUMENTS of the Maintenance module.

1. **Get your bearings.** Read `docs/STATUS.md`, the Phase $ARGUMENTS section of `docs/ROADMAP.md`, and `docs/DECISIONS.md`. Confirm the previous phase was approved. Run `npm test` and note the baseline; stop and report if anything already fails.
2. **Check prerequisites.** If the phase lists decisions or data needed from the owner (for example K-6 asset list, K-8) and they are missing, ask before building the parts that depend on them. Build the rest.
3. **Plan briefly.** Write a short plan for the owner: what you'll build, the migration, permissions to add, behaviour changes to existing pages (especially Production). Anything that changes Production behaviour needs explicit approval first.
4. **Build in small steps,** following the conventions in CLAUDE.md: migration with `.down.sql` → service → routes with `requirePermission` → views → tests. Run the relevant test file after each step.
5. **Verify for real.**
   - `npm test`: all files pass.
   - Migration: up → down → up on a scratch copy of the live dump; existing rows unchanged (row counts and checksums).
   - Production regression: Production pages show the same content before and after on that copy.
   - Browser: open every new or changed page as each role that can see it, at 1440 px and 820 px; fix layout problems; check keyboard focus and that read-only users see no action buttons.
   - Never write "verified" for anything you did not run.
6. **Report** in the format in CLAUDE.md, update `docs/STATUS.md` (and `docs/ROADMAP.md` if the plan changed, with the reason), then **stop and wait for the owner's approval.**
