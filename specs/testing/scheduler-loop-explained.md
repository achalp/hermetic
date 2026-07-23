# Scheduler Loop — How It Works, Why the Caveat, What Breaks When

_Last updated: 2026-04-25_

This document explains the scheduler that powers Item #5 (Scheduled local re-runs), why dev mode behaves differently from production, and what users should expect.

---

## What the scheduler is

Hermetic's scheduler is a single `setInterval` loop running inside the Next.js server process. Every 60 seconds it walks `data/schedules.json`, finds entries whose `nextRunAt <= now`, and executes them sequentially through the schema-compat fast path (no LLM call). It also maintains chokidar file watchers for `on-file-change` schedules.

The implementation lives in `src/lib/saved/scheduler.ts`. It is started lazily by `ensureSchedulerStarted()`, which runs the first time any schedule API endpoint is hit after server boot.

---

## Why "single Next.js process" matters

Hermetic is designed as a **single-tenant local app**: one user, one `npm run dev` (or one `npm start`), one machine. This shapes every scheduler decision:

| Hermetic's reality                               | Why the scheduler fits                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------- |
| Single Node.js process owns all the state        | One `setInterval` is enough — no leader election, no distributed locks |
| Schedules live in a local JSON file              | Trivially shared across restarts; no database needed                   |
| Background runs use the same sandbox the UI uses | No separate worker process; same code paths as live queries            |
| User is in front of the machine                  | "Tail of last error" is enough notification — no email/Slack           |

If Hermetic were a hosted multi-tenant SaaS, the scheduler would need an entirely different architecture — a separate worker process, distributed locks, retry queues, dead-letter handling. None of that exists here, and it shouldn't.

---

## The caveat: `npm run dev` vs `npm start`

In production (`npm run build && npm start`), the Next.js server is a single long-running process. Once `ensureSchedulerStarted()` fires, the loop runs forever; schedules tick on time, file watchers fire on every save.

In **dev mode** (`npm run dev`), Next.js does Hot Module Replacement. When a source file changes, the dev server may reload route modules — including `src/lib/saved/scheduler.ts`. After a reload:

1. The old module's `setInterval` is **lost** (the closure is GC'd; the timer remains in Node's event loop but its handler points to a stale module reference).
2. The new module's `started` flag is `false`.
3. The next API hit calls `ensureSchedulerStarted()` again, which spins up a fresh loop and re-registers chokidar watchers from `data/schedules.json`.

**Practical impact in dev:**

- A schedule due 3 minutes ago that you missed will fire on the next API touch (because `nextRunAt <= now` is still true).
- File-watch events that occurred between the HMR reload and your next API touch are **lost** (the old watcher closed, the new one hadn't started yet).
- Every page navigation that hits a server route effectively guarantees the scheduler is running.

This is acceptable for local development. In production, the loop is stable.

---

## The other caveat: process lifecycle

The scheduler exists **only while the Next.js server runs**. If you `Ctrl+C` the dev server or kill the production process:

- All in-memory `setInterval` and chokidar watchers stop immediately.
- `data/schedules.json` is preserved on disk.
- On next start, schedules are reloaded; any past `nextRunAt` is **honored** as soon as the scheduler resumes (because the due check is "≤ now", not "exactly at this time").

So if you stop Hermetic at 8 PM and restart at 10 PM:

- A "daily-9am" schedule with `nextRunAt = 9 AM tomorrow` won't fire until tomorrow.
- A "daily-9am" schedule with `nextRunAt = today at 9 AM` (i.e. due since this morning) will fire on the next tick after restart.
- A "hourly" schedule whose `nextRunAt = 8 PM` will fire as soon as the loop sees it after restart.

There is no concept of "missed runs go into a queue" or "fire each missed slot once" — the scheduler computes the next slot, runs it, and updates `nextRunAt` to the next future slot. Multiple missed hours collapse into a single catch-up run.

---

## File-watch (`on-file-change`) specifics

When you set a schedule with `cadence: "on-file-change"`, the scheduler:

1. Loads the saved viz.
2. Reads `meta.localPath` (the host filesystem path of the source data).
3. Spins up a chokidar watcher with `awaitWriteFinish: { stabilityThreshold: 500ms }`.
4. On a "change" event, calls `runScheduleNow(entry)`.

This means the watcher waits 500ms after the most recent write before firing — useful when an editor saves a file in multiple writes (e.g. some IDEs do "write to .tmp + rename"). The watcher does **not** fire on initial load (`ignoreInitial: true`).

**Watchers only attach to local-file vizs** (`meta.localPath` set). If you set "on-file-change" on a viz whose source is an upload or a warehouse, the watcher is silently skipped — the schedule will never fire. This is intentional: there's no external file mtime to watch on those source types.

---

## Multi-process gotcha (probably won't hit you)

If two Next.js servers somehow run against the same `data/schedules.json` (e.g. you accidentally run `npm run dev` and `npm start` in two terminals from the same directory), both schedulers will tick. A due schedule will be picked up by whichever process gets there first; the other will see the updated `lastRunAt` on next read.

This is racy but not catastrophic — the worst case is a duplicate run. Hermetic's design assumes a single process; running multiple is unsupported.

---

## Things the scheduler explicitly does NOT do

These are deferred to a future v2 with their respective rationales:

| Feature                       | Why deferred                                                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Retry on failure**          | A failed run logs the error and waits for the next tick. Auto-retry would mask bugs in the saved code. The user can fix the analysis and click "Run now".                                                                                               |
| **PDF/DOCX/PPTX auto-export** | Those exporters are client-side (`html-to-image`, `jsPDF`, `docx`, `PptxGenJS`). Headless equivalents need either Puppeteer (heavy) or substantial port to server-side libraries. XLSX + CSV are server-side trivial — the auto-export ships with both. |
| **Custom cron expressions**   | Five presets cover 95% of intent (hourly, daily-9am, daily-eod, weekly-monday, on-file-change). Cron syntax is its own footgun.                                                                                                                         |
| **Per-schedule timezones**    | Uses local time. Hermetic is a local-machine app — your machine's timezone is usually what you want.                                                                                                                                                    |
| **OS notifications**          | Last-run badge in the UI is enough for a single-user local app.                                                                                                                                                                                         |
| **Backfill missed runs**      | Catch-up always collapses to one run. If you need historical periodic runs, write a one-shot script.                                                                                                                                                    |

---

## How to validate the scheduler is running

Three quick ways:

1. **Check the dev log:** when `ensureSchedulerStarted()` fires, you'll see `[INFO] Scheduler started` once.
2. **Set a 1-hour-from-now schedule, wait, observe:** `lastRunAt` updates, an XLSX appears in `~/.hermetic/scheduled-runs/<vizId>/`.
3. **Quickest:** create a schedule, click "Run now" in Settings → Auto-runs. The button hits `/api/vizs/schedule/run-now`, which calls the same `runScheduleNow()` the loop uses.

---

## Why this design instead of OS cron

Some users will ask: "why not just write a crontab entry?" Tradeoffs:

| OS cron                         | Hermetic scheduler                                              |
| ------------------------------- | --------------------------------------------------------------- |
| Survives reboots                | Doesn't (you must restart Hermetic)                             |
| Works without Hermetic running  | Doesn't (needs Hermetic alive)                                  |
| User has to install / edit cron | Configured from Settings UI                                     |
| No state, no status tracking    | Tracks lastRun, lastStatus, lastError                           |
| Output goes to stdout / mail    | Output goes to versioned files in `~/.hermetic/scheduled-runs/` |
| Works on every Unix             | Same (chokidar + Node — works on Windows too)                   |

For Hermetic's "I'm at my desk and want my dashboard to refresh every hour" use case, the in-process scheduler is the right tradeoff. If you genuinely need durable time-based runs that fire even when Hermetic is closed, OS cron + a CLI wrapper around `runScheduleNow` would be the v2 path.

---

## Where the source code lives

| File                                                  | Role                                                   |
| ----------------------------------------------------- | ------------------------------------------------------ |
| `src/lib/saved/schedule-storage.ts`                   | Persistence (JSON file), cadence math, status tracking |
| `src/lib/saved/scheduler.ts`                          | The loop, file watchers, run executor, auto-export     |
| `src/app/api/vizs/schedule/route.ts`                  | GET / POST / DELETE endpoints                          |
| `src/app/api/vizs/schedule/run-now/route.ts`          | Manual fire endpoint                                   |
| `src/components/app/settings/auto-runs-section.tsx`   | Settings UI                                            |
| `data/schedules.json`                                 | Persisted state (gitignored)                           |
| `~/.hermetic/scheduled-runs/<vizId>/<timestamp>.xlsx` | Auto-export output                                     |

---

## TL;DR

The scheduler is a `setInterval` inside the Next.js server. In production it's stable; in dev mode HMR can interrupt it but the next API touch resumes it from the persisted JSON. Schedules survive process restarts; their state lives in `data/schedules.json`. File watchers only attach to local-file source vizs. PDF/DOCX/PPTX auto-export is deferred — XLSX and CSV ship today.
