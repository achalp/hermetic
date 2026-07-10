# Fixes Log

Running record of non-obvious diagnoses and their fixes — the ones worth
re-reading before touching the same area again. Newest first.

---

## 2026-07-09 — Same failure on the BigQuery warehouse path (network loss mid-query)

**Commit:** `801f187`

The California NN question run against **BigQuery** (not the DuckDB sandbox)
failed the same way: client stream died at 13 min ("network error") and the
server's outbound BigQuery poll failed together —
`request to https://bigquery.googleapis.com/.../job_… failed, reason:` (empty
reason = socket died) and the BQ SDK's own retries gave up with `Failed after
3 attempts. Cannot connect to API`. Both directions dropping at once = local
network loss (idle sleep most likely; the BQ job may have finished server-side,
we just lost the connection to fetch it). This is NOT a SQL error, query error,
or resource limit.

Two gaps this exposed, both fixed:

1. **The wake lock only covered the Docker sandbox, not warehouse queries.** A
   warehouse query polls the API over the network for minutes and is equally
   vulnerable to idle sleep. `runWarehouseQuery` now wraps `executeSQL` in
   `withWakeLock`. `wake-lock.ts` moved `src/lib/sandbox/` → `src/lib/` (shared,
   not a sandbox concept).

2. **The repair loop treated connectivity loss as a repairable SQL error.** New
   `isConnectivityError()` (sql-generation.ts) matches the driver/SDK
   fetch-failure shapes ("Cannot connect to API", "Failed after N attempts",
   `request to … failed, reason:`, ECONNRESET/ETIMEDOUT/ENOTFOUND, socket hang
   up). The loop now bails on these UNCONDITIONALLY (regenerating SQL can never
   fix a dead network, and the repair's own LLM call needs that same network)
   and rethrows "Lost the network connection to the &lt;engine&gt; API mid-query
   … reconnect and re-run" instead of the cryptic driver string after wasted
   attempts.

---

## 2026-07-09 — Long remote-scan queries fail mid-run with "network error" (idle sleep)

**Commits:** `1d40d6f`, `3c5b8bf`, `49d4630` (branch `remote-cloud-parquet-source`, PR #93)

### Symptom

An Overture-scale remote query — e.g. "which building is farthest from its
nearest neighbor in California / Seattle" — streams normally, then the browser
shows `TypeError: network error` at an arbitrary 7–18 minute mark and the run
appears to fail with no result. Recurred ~5 times over 2026-07-08/09. The user
recalled the same query finishing in a few minutes "before the recent fixes",
which pointed suspicion (wrongly) at the code-gen changes.

### Diagnosis (proven, not inferred)

Three hypotheses were on the table: (a) a code-gen regression made the query
slow, (b) an HTTP/proxy/keepalive timeout was cutting the stream, (c) the
machine was sleeping. The on-disk record settled it:

1. **The code-gen guidance was NOT the regression the user remembered.**
   History (`data/history/*/meta.json`) showed every "fast" Seattle run
   (25 s–2.5 min) used a hardcoded lat/lon **bounding box**, and predated the
   named-region **polygon** rule (`75741e0`) and city-lookup rule (`34d548f`).
   No polygon-based building query had ever actually completed — the post-fix
   California entries in history are persisted error cards (`0 ms`,
   `chartTypes: ['Annotation']`). So "it used to work with the polygon" was a
   false memory; the fast runs were bbox-only.

2. **The transport is clean.** A dev-only probe route (`/api/dev-stream-probe`,
   404 in prod) streams a keepalive-cadence tick every 15 s for 25 min. Two
   probes ran the full 25 min (`elapsedS: 1500`) with **zero gaps** in the
   tick log. So it is not Node's `requestTimeout` (already raised to 25 min by
   `scripts/server-timeouts.mjs`), not the dev proxy, not the 15 s keepalives.

3. **The machine idle-slept mid-run — provable from the clock.** The sandbox
   timeout is a Node `setTimeout` (`docker-utils.ts` `run()`), which only
   advances while the process is AWAKE. Run `86026d60` "timed out" reporting
   **40.6 min of wall clock against a 20-min budget**
   (`Docker: execution threw {ms: 2434797, isTimeout: true}`). A 20-min timer
   taking 40.6 min of wall clock to fire means it was frozen ~20 min = the
   machine slept ~20 min. Corroborating tells: the store-sweeper's fixed
   30-min interval showed 80-min real gaps on affected nights, and the client
   "network error" fires in the same second as the server's "Client
   disconnected" — the network interface dropping at sleep onset. Sleep also
   breaks the container's DuckDB→S3 connections, so the scan stalls and does
   not recover on wake.

### Fixes

1. **Two-phase division boundary fetch** (`1d40d6f`, `prompts.ts`). Independent
   of sleep: the named-region polygon LOOKUP itself was unoptimized — a
   one-shot `SELECT ST_Union_Agg(geometry) ... WHERE <name>` reads the geometry
   column of the ENTIRE global `division_area` dataset (a name predicate prunes
   nothing). Now mandated two-phase: **Phase A** aggregates the area extent from
   the tiny `bbox` struct only (`MIN/MAX(bbox.*)`, seconds even globally, NaN
   guard on no-match); **Phase B** re-reads WITH geometry filtered by the
   Phase-A extent as bbox literals, so only nearby row groups decode geometry.
   The extent doubles as the source table's pre-filter box.

2. **Don't discard completed work on disconnect** (`3c5b8bf`, both query
   routes). Both routes had `if (closed()) return` immediately AFTER execution —
   so a client drop during the (longest, most disconnect-prone) execution phase
   threw the finished result away: no compose, no artifacts, nothing for
   `persistHistoryOnDisconnect` to save. This silently defeated the
   disconnect-survival design (`55f1427`) for its primary case. Removed; compose
   now streams into the dead socket (`emit()` no-ops) and the assembled spec is
   saved to History. Pre-execution `closed()` checks stay (cancel before spend).

3. **Wake lock during execution** (`49d4630`, `src/lib/sandbox/wake-lock.ts`).
   `withWakeLock()` holds `caffeinate -i -s` for the duration of the docker
   exec — macOS-only, best-effort (missing `caffeinate` → transparent no-op),
   released the instant the run finishes. Prevents IDLE sleep (the walk-away
   case). **Cannot** override a closed lid — nothing in userspace can.

4. **Honest suspension reporting** (`49d4630`, `docker-executor.ts`). On a
   timeout, `wallMs - execTimeout` ≈ how long the timer was frozen = sleep
   duration; when > 1 min the log carries `{likelySuspended, approxSuspendedMs}`
   and the user-facing error says _"the machine appears to have slept ~N min …
   keep it awake and re-run"_ instead of blaming a slow query. Also added a
   symmetric `Docker: execution finished/threw` log — execution used to end
   silently, which is exactly why the first three failures could not be
   diagnosed from logs.

5. **Region-polygon per-point cost** (`49d4630`, `prompts.ts`). Made
   `ST_Simplify(geom, 0.001)` (~100 m) MANDATORY (was "if slow") and prescribed
   materializing the boundary as a temp table. California's coastline boundary
   has tens of thousands of vertices; `ST_Contains` cost is vertices ×
   points-tested, so the per-point test over ~13.7M buildings against the
   full-detail polygon is itself a 20-min sink. Simplify cuts vertices ~10–50×
   at negligible accuracy for building-scale point tests; the temp table pins
   the simplified geometry so it is read once, not re-planned into the scan.

### Still open

No CLEAN awake completion of the California case (13.7M buildings) has been
measured — every attempt slept. Re-run with the machine kept awake (the wake
lock handles idle sleep; a closed lid still kills it). If it still times out
awake, the next lever is confirming `ST_Simplify` is actually applied and
profiling the `ST_Contains` survivor phase vs the raw scan.

### How to recognize a recurrence

Mid-run "network error" on a long remote query → suspect sleep FIRST. Check the
`Docker: execution threw` log for `ms` (wall) far exceeding the `execTimeout`
budget, or gaps in the store-sweep cadence. The wake lock covers idle sleep; a
closed lid does not. See also memory `project_sandbox_sleep_wakelock` and
`project_overture_named_region_polygon`.
