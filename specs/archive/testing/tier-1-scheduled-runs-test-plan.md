# Test Plan — Scheduled Local Re-runs (Tier 1, Item #5)

_Last updated: 2026-04-25_

**Spec:** [`tier-1-implementation-plan-2026-04-25.md`](../tier-1-implementation-plan-2026-04-25.md) §"Item #5"

---

## What this feature does

A saved visualization can be scheduled to re-execute on a cadence (or on file change). On each run, the latest computed dataset is auto-exported to disk. Status (last run, success/error) is tracked per schedule.

Local-first: no cloud schedulers. The Next.js server process owns the scheduler loop.

---

## Scope: v1 vs deferred

**v1 (this PR):**

- ✅ Schedule storage (`data/schedules.json`)
- ✅ 5 cadence presets: `hourly`, `daily-9am`, `daily-eod`, `weekly-monday`, `on-file-change`
- ✅ Background scheduler loop (every 60s, lazy-init on first API touch)
- ✅ File-watch via chokidar for `on-file-change` schedules (debounced 500ms)
- ✅ Headless re-execution via the schema-compat fast path (no LLM call)
- ✅ Auto-export to **XLSX** and **CSV** of the latest computed dataset
- ✅ Status tracking: `lastRunAt`, `lastStatus`, `lastError`, `nextRunAt`
- ✅ CRUD endpoints + `run-now` endpoint

**v1 + Settings UI shipped (2026-04-25 update):**

- ✅ Settings UI panel ("Auto-runs" section in the Settings drawer) lists every saved viz with cadence dropdown, auto-export checkboxes (XLSX/CSV), Run-now button, and live status badge

**Deferred to v2:**

- ❌ Auto-export to PDF / DOCX / PPTX (those exporters are client-side; headless versions need Puppeteer or substantial refactoring)
- ❌ Custom cron expressions (only the 5 presets in v1)
- ❌ OS notifications on success/failure
- ❌ Schedule-specific timezones (uses local time)

For an in-depth explanation of how the scheduler loop actually behaves
(dev vs prod, what happens during HMR, multi-process gotchas, and why
the design is the way it is), see
[`scheduler-loop-explained.md`](./scheduler-loop-explained.md).

---

## Files changed / added

- `src/lib/saved/schedule-storage.ts` — **new**: storage, cadence math, status tracking
- `src/lib/saved/scheduler.ts` — **new**: scheduler loop, file watchers, run executor, auto-export
- `src/app/api/vizs/schedule/route.ts` — **new**: GET / POST / DELETE
- `src/app/api/vizs/schedule/run-now/route.ts` — **new**: manual trigger
- `src/lib/api.ts` — added `listSchedules`, `setSchedule`, `deleteSchedule`, `runScheduleNow`
- `package.json` — `chokidar` added
- `src/lib/__tests__/schedule-storage.test.ts` — **18 unit tests**
- `scripts/bump-mtime.sh` — helper for testing on-file-change schedules

---

## Automated tests

```bash
npx vitest run src/lib/__tests__/schedule-storage.test.ts
```

Expect: **18 passed**. Coverage:

- **Cadence math:** hourly rounds to next top-of-hour; daily-9am picks today if before 9, tomorrow otherwise; daily-eod same with 6pm; weekly-monday targets next Monday 9am with full Sun→Mon and Mon→next-Mon transitions; `on-file-change` returns null
- **CRUD:** create new, list, idempotent overwrite preserves createdAt + lastRunAt
- **Delete:** returns true/false correctly
- **recordRunOutcome:** updates lastRunAt + lastStatus on success and failure; recomputes nextRunAt; ignores unknown vizId
- **findDueSchedules:** picks past nextRunAt; excludes on-file-change schedules

```bash
npm run type-check
```

Expect: clean.

---

## Manual smoke test

The scheduler runs in the Next.js server process. Tests below assume `npm run dev` is running.

### Setup

1. Save a visualization first (any analysis from a CSV upload). Note its `vizId` (visible in the saved-vizs panel or via `GET /api/vizs`).
2. Optionally: copy `data/test-fixtures/tier-1/scheduled-runs/sample-input.csv` somewhere local and create a saved viz against it (so the on-file-change test has a known path).

### Test 1 — set + run-now

```bash
curl -X POST http://localhost:3000/api/vizs/schedule \
  -H 'Content-Type: application/json' \
  -d '{"vizId":"<your-viz-id>","cadence":"hourly","autoExport":["xlsx","csv"]}'
```

Expect: `{ ok: true, schedule: {...} }` with `nextRunAt` set to the next top-of-hour.

```bash
curl -X POST http://localhost:3000/api/vizs/schedule/run-now \
  -H 'Content-Type: application/json' \
  -d '{"vizId":"<your-viz-id>"}'
```

Expect: `{ ok: true }` after a few seconds (sandbox execution time).

**Pass:**

- A new XLSX appears at `~/.hermetic/scheduled-runs/<vizId>/<timestamp>.xlsx`
- A new CSV appears at `~/.hermetic/scheduled-runs/<vizId>/<timestamp>.csv`
- The schedule's `lastRunAt` and `lastStatus = "success"` are updated (verify with GET)

### Test 2 — list

```bash
curl http://localhost:3000/api/vizs/schedule
```

Expect: array containing your schedule entry.

### Test 3 — on-file-change

1. Set a schedule with `cadence: "on-file-change"` for a viz whose `localPath` is set
2. Run `./scripts/bump-mtime.sh <localPath>`
3. Wait up to 1s for the watcher to fire

**Pass:**

- A new export file appears in `~/.hermetic/scheduled-runs/<vizId>/`
- `lastRunAt` updates

### Test 4 — error path

1. Set a schedule for a viz whose source is invalid (delete the saved-viz directory mid-test) and `run-now`

**Pass:**

- Response returns `{ ok: false, error: "..." }`
- Schedule's `lastStatus = "error"`, `lastError` populated

### Test 5 — delete

```bash
curl -X DELETE http://localhost:3000/api/vizs/schedule \
  -H 'Content-Type: application/json' \
  -d '{"vizId":"<your-viz-id>"}'
```

Expect: `{ ok: true, removed: true }`.

### Test 6 — survives restart

1. Set a schedule, run-now once, verify outputs
2. Stop and restart `npm run dev`
3. List schedules

**Pass:**

- The schedule is still there (loaded from `data/schedules.json`)
- The scheduler tick + watchers re-initialize on first API touch (per `ensureSchedulerStarted`)

---

## API contract

### POST /api/vizs/schedule

```json
{
  "vizId": "...",
  "cadence": "hourly|daily-9am|daily-eod|weekly-monday|on-file-change",
  "autoExport": ["xlsx", "csv"]
}
```

Returns: `{ ok: true, schedule: ScheduleEntry }`.

### GET /api/vizs/schedule

Returns: `{ schedules: ScheduleEntry[] }`.

### DELETE /api/vizs/schedule

```json
{ "vizId": "..." }
```

Returns: `{ ok: true, removed: boolean }`.

### POST /api/vizs/schedule/run-now

```json
{ "vizId": "..." }
```

Returns: `{ ok: boolean, error?: string }`.

### ScheduleEntry shape

```ts
{
  vizId: string;
  cadence: "hourly" | "daily-9am" | "daily-eod" | "weekly-monday" | "on-file-change";
  autoExport: ("xlsx" | "csv")[];
  createdAt: number;       // epoch ms
  lastRunAt: number | null;
  lastStatus: "success" | "error" | null;
  lastError: string | null;
  nextRunAt: number | null;  // null for on-file-change
}
```

---

## Known limitations / non-goals

- **Settings UI not wired in v1.** All schedule operations are CRUD-via-API. A Settings → Auto-runs panel is a follow-up task.
- **No PDF/DOCX/PPTX auto-export.** Those exporters are client-side; XLSX + CSV are the v1 server-side options.
- **HMR can disrupt the loop in dev.** Production = single long-running process; the scheduler is stable. Dev mode reloads re-init from disk on first API touch.
- **Single-process model.** If multiple Next.js instances run against the same `data/schedules.json`, they will both tick. Hermetic is designed as a single-process local app, so this is acceptable.
- **No retry on failure.** A failed run records the error and waits for the next cadence. Re-trying is up to the user via run-now.
- **Timezone:** uses local time on the host. Timezone-aware schedules are deferred.
- **on-file-change watchers** apply only to saved vizs with `meta.localPath` set (i.e. local-file sources). Upload and warehouse sources only support time-based cadences.

---

## Sample fixtures

- `data/test-fixtures/tier-1/scheduled-runs/sample-input.csv` — small file you can use as a local-file source for testing on-file-change
- `scripts/bump-mtime.sh` — `touch`'s a path so the watcher fires

---

## Rollback

Delete:

- `src/lib/saved/scheduler.ts`
- `src/lib/saved/schedule-storage.ts`
- `src/app/api/vizs/schedule/route.ts`
- `src/app/api/vizs/schedule/run-now/route.ts`
- `src/lib/__tests__/schedule-storage.test.ts`
- `scripts/bump-mtime.sh`
- `data/schedules.json` (if any schedules were created)
- `~/.hermetic/scheduled-runs/` (any output files)

Revert:

- `src/lib/api.ts` (drop `listSchedules`, `setSchedule`, `deleteSchedule`, `runScheduleNow`, and the `ScheduleCadence` / `ScheduleEntry` exports)
- `package.json` (`npm uninstall chokidar`)

No other files in the app reference the scheduler.
