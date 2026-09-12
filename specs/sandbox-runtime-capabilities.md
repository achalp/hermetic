# Sandbox runtime capabilities — feature enumeration by execution runtime

Factual reference for what each sandbox runtime provides to generated analysis
code. Every row is traced from source (anchors given) and states where the
behavior is pinned by tests. Two runtimes exist: **docker** (containers built
from `docker/sandbox/Dockerfile`, executors in `src/lib/sandbox/docker-*.ts`)
and **wasm** (Pyodide + DuckDB-WASM in a CSP-locked browser worker,
`src/lib/sandbox/wasm/*`, dispatched at `src/lib/sandbox/index.ts`).

Status legend: ● default · ◐ conditional (condition noted) · ○ not provided.
Maintained as of 2026-09-10; update rows when the wiring changes.

## Runtime selection & routing

| Feature                                         | docker                                                                                              | wasm                                                                                                                                                                                                                        |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selection                                       | default when the daemon is reachable                                                                | user-pinned, `dockerAvailable === false`, or `HERMETIC_FORCE_RUNTIME=wasm` (`runtime-config.ts`)                                                                                                                            |
| Routing gate                                    | `planSandboxRouting` (`sandbox/index.ts:131`) — mount/remote/network capability checks, fail-closed | same gate; wasm passes remote runs only because generated SQL addresses registered ALIAS names, never remote URLs (`capabilities.ts` keeps `supportsRemoteIO:false`; pinned in routing.test.ts)                             |
| Pre-dispatch capability check of generated code | ○ (failures surface at runtime)                                                                     | ● `detectUnsupportedFeatures` (`wasm/prelude.ts`) — unsupported imports, in-worker remote reads, non-vendored extension LOAD/INSTALL; fails in 0 ms with a retryable reason (`index.ts` wasm branch; wasm-dispatch.test.ts) |

## Python environment

| Feature                                                        | docker                                             | wasm                                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Interpreter                                                    | ● Python 3.11-slim, digest-pinned (`Dockerfile:4`) | ● Pyodide 314.0.6 (Python 3.14)                                                                                  |
| pandas / numpy                                                 | ● 2.2.3 / 2.2.4, pip-pinned                        | ● 3.0.2 / 2.4.6, preloaded every run (`worker-source.ts`)                                                        |
| scipy                                                          | ● 1.15.2                                           | ◐ loaded iff the code imports it (prelude-parity.test.ts)                                                        |
| matplotlib                                                     | ● 3.10.1                                           | ◐ loaded iff imported (dist 3.10.8); `MPLBACKEND=AGG` set by the prelude                                         |
| scikit-learn                                                   | ● 1.6.1                                            | ◐ loaded iff imported (dist 1.8.0)                                                                               |
| seaborn                                                        | ● 0.13.2                                           | ○ no wheel in the Pyodide distribution; imports are flagged pre-dispatch with a reroute reason (prelude.test.ts) |
| statsmodels / lifelines / networkx                             | ○ (not in the image)                               | ○ flagged pre-dispatch                                                                                           |
| Runtime package installs (pip/micropip)                        | ○                                                  | ○ (absence pinned in worker-source.test.ts)                                                                      |
| Interpreter/package versions are NOT identical across runtimes | —                                                  | — (a cross-runtime behavioral difference to keep in mind; converging is an image-upgrade decision)               |

## DuckDB

| Feature                                         | docker                                          | wasm                                                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Engine                                          | ● native duckdb 1.2.2 (pip)                     | ● duckdb-wasm blocking MVP v1.5.4, synchronous XHR I/O (`duckdb-worker.ts`)                                                                                  |
| parquet extension                               | ●                                               | ● from the local same-origin repo `/duckdb/ext` (`build-duckdb-wasm-assets.mjs`)                                                                             |
| httpfs extension                                | ● baked into the image (`Dockerfile:33`)        | ◐ INSTALL+LOAD at boot only when range aliases exist                                                                                                         |
| spatial extension                               | ● baked into the image                          | ◐ vendored in the local repo; INSTALL+LOAD at boot when `codeNeedsSpatial(code)` (LOAD/INSTALL spatial or ST_* usage) — e2e-verified with real geodesic math |
| Other extensions                                | ◐ INSTALL possible only with egress             | ○ non-vendored LOAD/INSTALL flagged pre-dispatch                                                                                                             |
| Reading staged files (`FROM '/data/input.csv'`) | ● container filesystem                          | ● every staged data file (csv/tsv/parquet/json/jsonl) is `registerFileBuffer`'d under its /data path (worker-source.ts; e2e-verified)                        |
| Reading remote parquet                          | ● httpfs through the egress proxy               | ● byte-range reads of same-origin `/api/wasm-range/<token>` aliases; worker picks offsets, never destinations                                                |
| memory_limit / threads / spill PRAGMAs          | ● self-tuned from the cgroup cap (`prelude.py`) | ○ engine knobs do not exist in the browser build; config is fixed at `db.open` (ranged-read filesystem flags)                                                |
| Result materialization bound                    | ● type-aware `.df()` row cap (`prelude.py`)     | ● 500,000-row cap at the Arrow→JSON boundary with retry-actionable text (e2e-verified)                                                                       |
| Engine-error legibility                         | native errors                                   | ● `_setThrew` shim converts the upstream blocking-build defect into a named error (`build-duckdb-wasm-assets.mjs`; build-asserted)                           |

## Remote data & egress

| Feature                   | docker                                                                       | wasm                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Egress enforcement        | ● per-run L7 allowlist gateway, fail-closed (`egress.ts`, `egress-proxy.py`) | ● Rust egress core `fetchRange` with allowlist re-check per request + worker CSP `connect-src 'self'` |
| Credentials               | ● `applyRemoteAuth` at the executor boundary only; placeholders in prompts   | ◐ host-side allowlist derivation; the worker never sees credentials or upstream URLs                  |
| Parquet footer prefetch   | n/a (not needed)                                                             | ● 256 KiB tails, 16-way, best-effort (`footer-prefetch.ts`)                                           |
| Hive / multi-file sources | ● glob reads                                                                 | ● one token per file; `=` preserved in alias names so hive partitioning derives columns               |
| Byte budgets              | n/a                                                                          | ● per-token budgets charged pre-fetch; 64 MiB per-request cap                                         |

## Execution control

| Feature                        | docker                                                              | wasm                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Timeout                        | ● none on the ephemeral path (stop-on-demand); 30s on the warm path | ● none when the run supplies its AbortSignal (production always does); a 120s fallback exists only for signal-less callers, and it also cancels the worker                                                                                                                                                                                       |
| Stop / cancel                  | ● abort → `docker rm -f` of the run's containers                    | ● abort → handoff rejects (`errorKind:"stopped"`) + `__wasm_cancel` stream patch → browser terminates the worker (run-control.test.ts exercises the production binding, aborting from OUTSIDE the run's async context)                                                                                                                           |
| Live progress                  | ● stdout heartbeat thread, 5s + phase frames                        | ◐ phase-level: Python `progress()` → worker bridge → relay-validated frame → `POST /api/wasm-result` (kind:progress) → the run's onProgress. No mid-query ticks: Pyodide cannot run a heartbeat thread during a synchronous DuckDB call                                                                                                          |
| Ambient run context rule       | —                                                                   | — **Both runtimes:** callbacks that can fire from another request's context (abort listeners, browser-originated POSTs) must capture the runId EAGERLY at construction; `getRunId()` resolves the CALLER's AsyncLocalStorage, not the closure's (`ambientSandboxHooks` / `ambientWasmExecutor` in run-control.ts; pinned by run-control.test.ts) |
| OOM handling                   | ● cgroup watchdog, phase-aware remedies, 137 diagnostics            | ◐ no cgroup exists in a worker; the materialization cap bounds the dominant blow-up; a pandas-side overrun surfaces as a worker crash envelope                                                                                                                                                                                                   |
| Pre-flight undefined-name lint | ● pyflakes in-container, stdlib-AST fallback                        | ● the SAME shared checker (`sandbox/preflight-lint.ts`) in the worker pre-exec (stdlib-AST path — Pyodide has no pyflakes), identical retry message from the shared formatter (e2e-verified)                                                                                                                                                     |

## Output & diagnostics

| Feature                                                                         | docker                             | wasm                                                                                                                          |
| ------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Output contract (`write_output`, `declare_finding/check/series/value`, regimes) | ● hermetic_runtime staged per run  | ● identical staging + byte-identical prelude bindings (prelude-parity.test.ts)                                                |
| skill_lib / user_lib module staging                                             | ◐ active skills / configured users | ◐ same additionalFiles channel (wasm-dispatch.test.ts)                                                                        |
| Result decoding                                                                 | ● `parseSandboxOutput`             | ● same parser, `runtime:"wasm"`; envelopes cross the untrusted webview through the relay's shape/size/depth gate (`relay.ts`) |
| skillFailureHints in error parsing                                              | ●                                  | ● threaded through the executor (wasm-dispatch.test.ts)                                                                       |
| `HERMETIC_DUCKDB_CFG` self-report                                               | ● file + live-stream channel       | ○ structurally n/a (no PRAGMA block); the diag states this explicitly (parse-output.test.ts)                                  |
| stdout.txt post-mortem                                                          | ●                                  | ○ the relay forwards output.json + stderr only, by security design                                                            |

## Isolation & lifecycle

| Feature                         | docker                                                                              | wasm                                                                                                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolation boundary              | ● `--network none` / L7 gateway; cap-drop, pids, cpu, memory flags (`hardening.ts`) | ● worker CSP (`connect-src 'self'` on the Tauri-local origin) + relay validation; analysis code can reach same-origin API routes — documented residual (runtime-constants.ts D10 note) |
| Fresh workdir per run           | ● warm-path cleanup before staging                                                  | ● `rmtree`+`makedirs` every run; the worker itself is fresh per run (worker-source.test.ts)                                                                                            |
| Warm reuse                      | ● per-process warm container, 24h                                                   | ○ n/a — per-run worker by construction                                                                                                                                                 |
| Bind mounts / copied-in parquet | ●                                                                                   | ○ n/a — MEMFS only; inputs arrive as same-origin token fetches                                                                                                                         |
| Container/worker reaping        | ● run-labeled sweep (`lifecycle.ts`)                                                | ● worker terminated on completion, cancel, and fallback timeout                                                                                                                        |

## Build & CI controls (wasm)

- Assets built by `scripts/build-duckdb-wasm-assets.mjs`: classic-worker bundle,
  mvp wasm module, local extension repo (parquet, httpfs, spatial), `_setThrew`
  shim with a both-directions build assertion; `--offline` for packaging.
- Pyodide wheels vendored for offline desktop by `scripts/ensure-pyodide-wheels.mjs`
  (numpy, pandas, scipy, matplotlib, scikit-learn; PEP-427 name normalization).
- `worker-source.ts` is a TEMPLATE LITERAL: regex metacharacters in embedded
  code must be double-escaped (`\\b`, `\\s`) or they ship as control characters
  (worker-source.test.ts pins the intact patterns).
- Isolation boundary check (`scripts/isolation-check.mjs`) and a 100% coverage
  gate on the wasm pure modules (vitest.config.ts).
- Behavioral e2e (`e2e/wasm-range-extraction.spec.ts`) drives the production
  worker source + real shipped assets: ranged schema extraction, two-alias
  join, spatial ST_* math, staged-file reads, the pre-flight lint, and the
  materialization cap. Gated Node-Pyodide integration under
  `HERMETIC_WASM_TEST=1`.

## Known runtime gaps (open)

| Gap                                                     | Detail                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Warehouse results >100k rows are Docker-only            | `materializeCsvToParquet` hard-throws on non-Docker runtimes ("Parquet materialization is only supported with the Docker sandbox runtime"), so a large warehouse result on the wasm tier fails instead of falling back to the in-process CSV profiler (`lib/csv/schema`) that sub-100k results already use. |
| ~~Manifest eager connect cannot cover a large catalog~~ | CLOSED by profile-on-demand (see below).                                                                                                                                                                                                                                                                    |

## Source metadata tiers (file sources)

Three tiers, only the third of which is expensive. Warehouses are out of scope:
they carry no value statistics at all (`WarehouseColumnInfo` is name/type/nullable
plus a catalog `row_count_estimate`), so they have always been tier 2.

| Tier     | What it reads                                                | Cost                              | When                                                                 |
| -------- | ------------------------------------------------------------ | --------------------------------- | -------------------------------------------------------------------- |
| Catalog  | manifest-declared columns/row hints                          | zero                              | connect (lists the catalog; `eagerCapable: () => false`)             |
| Describe | `DESCRIBE` + parquet footers → names, types, exact row count | seconds, no row egress            | a question needs an entity whose profile failed; the INCLUSION FLOOR |
| Profile  | value statistics over `profileDepth` rows                    | ~50s+ per entity, bandwidth-bound | a question picks an entity, or "Profile this table"                  |

Rules that hold across them:

- A failed profile NEVER removes a table from a question — it degrades to
  Describe, columns marked `unprofiled`, stated per column in the prompt. Only a
  failed `DESCRIBE` means unusable.
- A describe-only schema is never cached under the profile's key (it would read
  as a successful profile forever and block the upgrade).
- Depth (`PROFILE_DEPTHS`, default 50k) is a cache REUSE gate via
  `profileSatisfiesDepth`, not part of source identity: deeper satisfies
  shallower, a full scan satisfies everything.
- No wall clock on a profile — it is bandwidth-bound, so cancellation is the
  user's Stop (`request.signal`). Metadata work keeps its timeout, because its
  duration does not scale with the data.
- Numeric min/max come from parquet FOOTER statistics (exact, whole-dataset, no
  scan) and the sample is spread across files, not taken from the head. Measured
  on 750k rows in 3 files where only the last holds the maximum: a 500k head
  prefix reported max 1,249,999; spread+footers reports the true 2,249,999 at
  both 50k and 500k depth. `profile_basis` records which basis produced a
  schema's statistics.

### Known remaining limitation

Spreading across FILES does not fix ordering bias WITHIN a file: each file still
contributes its leading rows, so a within-file sorted column keeps a skewed mean
(measured: true mean 1,124,999.5; spread 500k gave 1,083,332.5; the old head
prefix gave 624,999.5). Ranges are unaffected — they come from footers. Fixing
the rest means sampling row groups within each file.

## Scaffold code (tested, intentionally not on the production path)

- `wasm/executor.ts` — Node-Pyodide parity executor, CI only.
- `wasm/duckdb-bridge.ts`, `wasm/duckdb-engine.ts`, `wasm/transport-node.ts` —
  SAB/Atomics scaffolding superseded by the blocking build.
- `wasm/egress-guard.ts` — superseded by range tokens + the Rust egress core.
