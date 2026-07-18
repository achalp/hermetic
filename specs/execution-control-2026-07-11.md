# Execution control — never self-kill, stop on demand, meaningful progress

_Created: 2026-07-11_

## Problem

We hard-killed every sandbox run at 20 min. But genuinely long analysis is
legitimate — the same "farthest building in California" question measured 12 min
and **56 min** in the history; both were destroyed at 20. The root cause was one
design choice: the sandbox exec was a single **blocking** call with a
`setTimeout` that aborted it. That forced the self-kill, blocked live progress,
and blocked cancellation.

Decisions (user): (1) truly no ceiling; (2) stop via a dedicated endpoint;
(3) hands-off (no cost check-ins).

## Design

One unifying primitive — a **per-run `AbortController` registry** keyed by the
`runId` already in AsyncLocalStorage (`src/lib/pipeline/run-control.ts`). It's a
module-level map because the stop request is a SEPARATE request, outside the
run's ALS. Everything long-running subscribes to the run's signal; sandbox
containers register here so a stop can `docker rm -f` them; a progress sink
forwards execution progress to the patch stream. No timeout anywhere.

- **P1 — no self-kill + stop + streaming.**
  - `POST /api/query/stop {runId}` → aborts the signal (unwinds LLM streams /
    warehouse polling) + force-removes the run's containers.
  - `stream-exec.ts`: spawn-based streaming runner — `python3 -u`, JSONL
    `__progress` parsed off stdout live, resolves on process exit, and on
    `signal.abort` `docker rm -f`s the container (killing the in-container
    process; killing the exec client alone would not). **No timeout.**
  - docker-executor: container is `sleep infinity` (its lifetime was a second
    hidden self-kill), registers/unregisters with run-control, returns
    `errorKind "stopped"` on abort; orchestrator fail-fasts on it.
  - Uniform across Ask and Investigate (Investigate's N sub-execs register into
    the same run's container set — stop kills all) and every source.

- **P2 — meaningful, guaranteed progress.** The prelude gains
  `progress(phase, detail, **fields)` (writes `{"__progress": {...}}` to stdout,
  flush) + a daemon heartbeat every 5 s, so even a silent 40-min scan streams
  "still running, 12m" regardless of what the analysis code prints. Wire format
  is snake_case (`phase/detail/fraction/rows/total_rows/elapsed_ms`), streamed
  to `/state/__exec`. Code-gen guidance asks for phase labels + `fraction=`/
  `rows=` where known.

- **P3 — orphan reaping + estimate.** With no timers, a crashed/restarted run's
  `sleep infinity` container would leak — the store sweeper now reaps running
  `hermetic-sandbox-*` containers NOT in the live registry (the registry is the
  source of truth for "alive"; safe against the create→register window). An
  up-front `estimateRun()` buckets the run (quick/medium/long/very_long) into a
  human range + "you can stop it anytime" — never a false-precise ETA — streamed
  to `/state/__estimate`.

- **P4 — UI + BigQuery consequence.** `ExecProgress` (shared by Ask +
  Investigate) renders the estimate banner, live phase/elapsed/bar, and the Stop
  button (POST /stop with `__runId`). BigQuery `executeSQL` drops its 20-min
  `jobTimeoutMs` (itself a self-kill) — superseded by Stop + BigQuery's own 6h
  hard limit.

## The one honest gap (BigQuery job cancellation)

The sandbox/Parquet path — the reported pain — is fully covered: Stop kills the
container immediately. For a **warehouse** query, Stop aborts the request but the
submitted BigQuery job keeps running server-side until BigQuery finishes (BQ's
6h ceiling). True cancellation needs `createQueryJob` + `job.cancel()` wired to
the run's abort signal — a documented follow-on. Same applies to
Snowflake/Trino/etc. (each has its own cancel).

## Files

`run-control.ts` (registry + reaper), `stream-exec.ts`, `estimate.ts`,
`api/query/stop/route.ts`, `exec-progress.tsx`; edits to `docker-executor.ts`
(sleep infinity + streaming + registration), `sandbox/index.ts` (prelude
progress), `patch-stream.ts` (registry wiring + `__runId`/`__exec`/`__estimate`),
`orchestrator.ts` (estimate + stopped fail-fast), `store-sweeper.ts` (reap),
`bigquery.ts` (drop jobTimeout), `response-panel.tsx` (ExecProgress).

## Follow-ons

- Warehouse job cancellation on Stop (per engine).
- Historical `wallMs` lookup to sharpen the estimate (data is in cost/
  diagnostics; today the estimate is heuristic from row-count + remote).
- A stall-surfacing hint ("no new progress for N min") from the heartbeat.
