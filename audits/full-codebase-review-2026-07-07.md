# Hermetic — Full Codebase Review

- **Date:** 2026-07-07
- **Reviewed commit:** `34d548f` on branch `remote-cloud-parquet-source` (PR #93)
- **Scope:** design/architecture, code quality & hygiene, reuse/modularity, API layer & security posture, observability, frontend, test approach, documentation
- **Method:** six independent read-only review passes (architecture, API/security, core engine, frontend, observability, testing/docs), every finding grounded in file:line evidence and measurements; findings deduplicated and cross-referenced here
- **Codebase size at review:** ~73.6k LOC TS/TSX; 159 lib `.ts` + 144 `.tsx` source files; 108 test files, 1,128 tests
- **Audience:** this document is structured for an LLM (Opus) to action. Every finding carries a `Verify` command to (a) confirm the finding still exists before acting and (b) confirm the fix afterward. Follow the protocol in §2.

---

## 1. Executive summary

Hermetic is a deliberately engineered codebase with real strengths: clean layer direction (zero `lib → components/app` imports), genuinely shared hardening modules extracted after documented drift (Ask/Investigate), plugin-shaped seams for sandbox runtimes and warehouse connectors, concurrency-safe cost tracking via `AsyncLocalStorage`, exemplary chart code-splitting, per-widget render error boundaries, and a fast deterministic unit suite with a ratcheted coverage gate wired into CI.

The dominant weaknesses cluster into five themes:

1. **The Ask/Investigate route pair is still duplicating and re-diverging** (~600 lines of orchestration scaffold: streaming emit/keepalive/progress, warehouse materialization, cost epilogue, request validation, disconnect-persistence). Each copy has _already_ drifted — several fixes exist in only one route. This is the same failure mode the team previously fixed by extraction; the extraction is incomplete.
2. **Two god components** — `src/app/page.tsx` (1,684 lines, 33 useState, split-brain reducer) and the investigate route's 930-line stream closure — concentrate risk and block testability.
3. **Unvalidated boundaries** — the two most failure-prone JSON boundaries (LLM output, sandbox output) are cast-and-pluck (71 `as Record<string, unknown>` casts, zod used once in all of src/lib); ~40 API routes have zero schema validation.
4. **Observability gaps that directly caused recent debugging pain** — no run correlation ID, no dev-log timestamps, no stage durations, LLM cost leaks on 3+ routes, client diagnostics never reach the server.
5. **Test coverage is inverted relative to risk** — investigate-orchestrator at 97% but the LLM client at 4.9%, sandbox executors at ~10%, the ask-path orchestrator at 7%, API routes at 5.9%, and **the suite is red at HEAD** (see IMMEDIATE below).

### Dimension ratings

| Dimension                 | Rating   | One-line justification                                                                                                                                       |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Architecture & modularity | adequate | Clean layering and real shared modules, but ~600 lines of re-diverging route duplication + a 1,684-line page component                                       |
| API layer & security      | adequate | Good local-tool defense-in-depth (rate limit, origin checks, UUID path guards); no schema validation; several hosted-context P0s (path traversal, SSRF, SQL) |
| Core engine quality       | adequate | Well-commented, safe concurrency primitives; dragged down by 250-370-line duplicated LLM/sandbox transport blocks and a cast-based JSON boundary             |
| Frontend                  | adequate | Strong rendering architecture (registry, boundaries, code-splitting); god page component, dead hook layer, zero memoization on the stream hot path           |
| Observability             | adequate | Solid per-run diagnostics/cost skeleton; no correlation ID, no stage timings, stack traces never logged                                                      |
| Testing                   | adequate | Disciplined fast suite + CI ratchet; highest-risk I/O layers near-zero covered; suite red at HEAD                                                            |
| Documentation             | adequate | Thorough README + rich spec artifacts; one false security claim, dead CHANGELOG, doc sprawl across 8 dirs                                                    |

### ⚠ IMMEDIATE (do these first, before any other action)

| ID     | What                                                                                                                                                                                                                      | Why now                                                                                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TEST-1 | **Test suite is red at HEAD**: commit `34d548f` rewrote prompt guidance in `prompts.ts` without updating 2 pinned assertions in `src/lib/llm/__tests__/prompts.test.ts` (line ~100, `toContain("filter on bbox FIRST")`). | This commit is pushed on PR #93 — CI will be red. Fix the two assertions (or re-pin to stable sentinels per TEST-9). `Verify: npx vitest run src/lib/llm/__tests__/prompts.test.ts` |
| DOC-1  | **README claims "no network access" for sandboxed code — false for the default Docker runtime** (`docker run` has no `--network none`; the codebase _deliberately_ supports in-sandbox S3 reads).                         | Users may rely on the documented isolation property for sensitive data. Either fix the claim or gate networking.                                                                    |

---

## 2. Actioning protocol for Opus

1. **Confirm before acting.** For every finding, run its `Verify` command first. If the evidence no longer matches (code moved/fixed), mark the finding `STALE` and skip it — do not "fix" something already fixed.
2. **Order of work:** IMMEDIATE items → Workstreams in §3 order → remaining P2s → P3s opportunistically (many P3s are one-line fixes that ride along with a workstream touching the same file).
3. **One workstream per PR/branch.** Findings within a workstream are designed to be fixed together (they touch the same files).
4. **Re-verify after fixing.** Each `Verify` line states the post-fix expected result. Additionally run: `pnpm type-check && pnpm test` after every workstream; `pnpm test:coverage` after the testing workstream.
5. **Do not break the strengths.** §6 lists load-bearing design decisions with evidence. In particular: the per-widget error boundary (`registry.tsx wrapAll`), the AsyncLocalStorage cost scoping, the `opChain` warm-sandbox serialization, dynamic imports for all charts, and the shared modules (`runWarehouseQuery`, `composeAndStreamDashboard`, `duckdb-source`) — extend these, never inline around them.
6. **Prompt-file caution:** `src/lib/llm/prompts.ts` has behavior-pinning tests. Any edit there requires updating `prompts.test.ts` in the same commit (root cause of TEST-1).

---

## 3. Prioritized workstreams

### WS1 — Unify the Ask/Investigate route pair (P1; the highest-leverage structural fix)

The pattern is proven in this repo: extract to lib, both routes consume. Remaining duplicated blocks, each already divergent:

| Finding         | Block                                                    | Divergence already present                                                                                                                                                                      |
| --------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ARCH-1          | Disconnect→persist history                               | Exists **only in Ask** (route.ts:583-609); Investigate (longer runs, more likely to drop) loses everything                                                                                      |
| ARCH-2 / API-10 | Streaming scaffold (emit/keepalive/emitProgress/headers) | Investigate fixed the `step === 1` state-clobber bug; Ask still has it. Ask has `no-transform` (proxy-buffering fix); Investigate doesn't. Different Content-Types for the same NDJSON protocol |
| ARCH-3          | Warehouse materialize-to-CSV (~100 lines each)           | Investigate's copy gained a Parquet path; Ask's didn't                                                                                                                                          |
| ARCH-4          | Cost/diagnostics epilogue                                | Investigate's is in `finally`; Ask's keepalive `clearInterval` (route.ts:577) leaks if the wrapper rejects                                                                                      |
| ARCH-10         | Request-validation preamble (~60 lines)                  | Model-validation provider lists have drifted (see ARCH-6)                                                                                                                                       |

**Deliverables:** `lib/pipeline/patch-stream.ts` (`createPatchStream()` → {emit, emitProgress, keepalive, headers}); `lib/warehouse/materialize.ts` (`materializeWarehouseResult()`); `lib/cost/epilogue.ts`; `lib/history/persist-on-disconnect.ts`; shared `validateQueryRequest()`. Both routes shrink to wiring.

### WS2 — Validate the JSON boundaries (P1-P2)

- CORE-5: zod schemas for the sandbox output envelope and the planner/replanner JSON, applied at single shared parse points; rejects feed the existing retry loops.
- CORE-2: extract one runtime-agnostic `parseSandboxOutput()` (currently copy-pasted 4× with drift — OOM detection only exists in the Docker path).
- CORE-12: the `\bNaN\b → null` regex over raw JSON corrupts legitimate strings ("NaN Zhu" → "null Zhu"); parse first, regex only as fallback on parse failure. Centralize in the shared parser.
- API-7: zod request-body validation on the highest-risk routes first (warehouse/connect, local-files/\*, remote-parquet).

### WS3 — Observability floor (P1-P2; directly addresses recent debugging pain)

- OBS-1: run correlation ID via AsyncLocalStorage, threaded into logger, diagnostics JSONL, cost CSV, history entry.
- OBS-3: timestamps in the dev log format (one-line fix).
- OBS-2: wrap suggest/recompose/rerun-step in `runWithCostTracking` (cost undercounting).
- OBS-5: per-phase `durationMs` alongside existing `withPhase` labels; `duration_ms` column in cost rows; surface the dead `slot.startedAt/finishedAt` writes.
- OBS-6: `serializeError()` helper (name + message + top stack frames + cause) at terminal `logger.error` sites.
- OBS-13: cost CSV append is read-modify-write with an acknowledged race — switch to the atomic append pattern run-diagnostics already uses.
- OBS-4 (P2): tiny `POST /api/client-log` bridge so `[ResponsePanel]` diagnostics reach server logs.

### WS4 — Security hardening for hosted-context risks (P2 now; P0 if ever hosted)

The app binds 127.0.0.1 by default (start.sh) — grade these accordingly, but fix before any hosting story:

- API-1: local-files routes resolve arbitrary absolute paths with no root-jail; origin check fails open when Origin absent. Add allowlisted roots + fail-closed.
- API-2: SSRF in remote-parquet/schema — scheme-only validation; add host validation (reject link-local/loopback/RFC-1918/metadata endpoints).
- API-3: no read-only enforcement on generated/edited SQL (`editedSql` passes straight to `pool.query`). Enforce SELECT-only / read-only transactions at the connector.
- API-4: warehouse/sample interpolates unvalidated `table` into SQL; Snowflake branch has zero escaping. Validate against `warehouse.tables` membership.
- API-5: `request.json()` failure on aborted duplicates → logged as ERROR + 500; return 400 and log at debug (known noise source).

### WS5 — Decompose the god components (P1-P2)

- ARCH-5 / FE-1: `page.tsx` (1,684 lines): fold `refreshStage`/`loadedVizId`/`lastCompleteSpec`/`analysisHistory` into the existing `pageReducer`; extract `useAnalysisRun`, `useHistoryRestore`, `useSuggestions` hooks (the `src/hooks/` seam already exists and is tested). Target < 400 lines.
- ARCH-9: investigate route's 930-line stream closure: extract `TraceRecorder` (the 149-line progress-event switch) into `lib/pipeline/investigation-trace.ts`.
- FE-2: delete the dead duplicated `useSaveExport`/`useArtifacts` instance inside response-panel (page.tsx owns the live ones; two instances with divergent csvId inputs invite drift).
- CORE-4 / ARCH-8: `runPipeline` 15 positional params → options object (style already used by `runPipelineWithCode`).

### WS6 — Test the risk, not the convenient (P1-P2)

Current inversion: investigate-orchestrator 96.8% vs LLM client 4.9%, sandbox 10.5%, ask orchestrator 7.0%, API routes 5.9%. In order:

- TEST-1 (IMMEDIATE, above).
- TEST-10: mirror the investigate-orchestrator test approach onto `orchestrator.ts` (mock generateCode + executeSandbox; assert retry counts, escalation, degraded propagation).
- TEST-3: sandbox arg-construction tests (stub `run()`, assert docker arg sequences + output-retrieval fallback chain).
- TEST-5: streaming/NDJSON protocol test (chunk-split reassembly, event ordering) — the most recently buggy area has zero tests.
- TEST-2: extract/inject SDK constructors in client.ts; test provider auto-detect, model routing, param-strip paths.
- TEST-8: `.husky/pre-push` running `pnpm type-check && pnpm test` (18s suite; would have prevented TEST-1).
- TEST-9: re-pin prompt tests to structural sentinels, not prose fragments (5 prompt-copy commits last week; one broke the suite).
- TEST-6: actually execute the Python prelude in an opt-in test (currently regex-pinned only).
- TEST-12: `coverage.reportOnFailure: true` in vitest.config.ts.

### WS7 — Consolidation & hygiene (P2-P3, ride-along fixes)

- CORE-1: extract shared Responses-API SSE translation from `ollamaFetch`/`localOpenAIFetch` (~250 duplicated lines, already drifted — one swallows stream errors the other handles).
- CORE-3: microsandbox executor should call its own `writeChunkedFile` (4 inlined copies of the loop it already exports).
- CORE-11: one `rowsToCsv()` for the 5 warehouse connectors' copy-pasted `csvValue` + serialization.
- ARCH-6: provider capability descriptor in client.ts; kill the two drifted hardcoded provider lists in the routes.
- ARCH-7 / CORE-14 / API-8 / API-9: one shared sweeper (in instrumentation-node.ts) for all lazy-expiry globalThis stores + tmpdir orphans + expired warehouse connectors; cap/prune `data/history/`; document the single-process constraint.
- CORE-6: memoize microsandbox `getOrCreateSandbox` creation promise (check-then-act race; pattern exists in warm-sandbox.ts:65-73).
- CORE-15: microsandbox/e2b lack large-data timeout + remote-IO guard → spurious 30s timeouts for code that works on Docker.
- FE-3: `React.memo` chart components + `useMemo` data transforms (zero memoization on the per-patch stream render path).
- FE-4: response-panel drill-down effect sends stale model/purpose/runtime settings (masked by an exhaustive-deps disable).
- FE-5: dev-gate the `console.error`/`window.onerror` monkey-patches in deckgl-init.ts (keep the tested ResizeObserver patch).
- FE-6: surface save/export failures (currently silent from the top bar).
- FE-7: shared `<ChartEmptyState>` for the 15 silent blank-box early returns.
- DOC-2..6, CORE-8, CORE-10, CORE-16, OBS-9..12, FE-8..13, ARCH-11..13, API-6: see full register.

---

## 4. Full findings register

Findings are verbatim from the dimension reviews (evidence, issue, recommendation, verify), deduplicated. Cross-references marked. Severity scale: P0 = exploitable/data-loss even locally; P1 = structural risk actively causing bugs or velocity loss; P2 = meaningful debt; P3 = polish.

### 4.1 Architecture (ARCH)

**ARCH-1 · P1 · Server-side history persistence on disconnect exists only in Ask, not Investigate**

- Evidence: `src/app/api/query/route.ts:53-58` (abort listener), `:166-179` (emittedLines accumulation), `:583-609` (assembleSpecFromPatches + persistHistoryEntry). `grep -c "persistHistoryEntry\|assembleSpecFromPatches\|abort" src/app/api/query/investigate/route.ts` → 0.
- Issue: Commit 55f1427 landed in Ask only. Investigate runs are longer (21-min budget) so more likely to hit a disconnect and lose the entire result. Live recurrence of the documented one-route-only drift pattern.
- Recommendation: Move the accumulate → assemble → persist block into `lib/history` and call from both routes' stream conclusion.
- Verify: `grep -n "persistHistoryEntry" src/app/api/query/investigate/route.ts` — currently no matches; after fix both routes (or a shared module) reference it.

**ARCH-2 · P1 · Streaming scaffold duplicated and already divergent** _(= API-10)_

- Evidence: Ask emitProgress keys the wholesale `/state` add on `step === 1` (route.ts:183); Investigate replaced that exact pattern with a `stateInitialized` flag after it clobbered `__warehouse_csv_id` (investigate/route.ts:249-270). Headers diverge: Ask `text/plain` + `no-cache, no-transform` (route.ts:623-631); Investigate `application/x-ndjson` + `no-cache` without `no-transform` (investigate/route.ts:1181-1183).
- Issue: The state-clobber bug fixed in Investigate is latent in Ask; the proxy-buffering fix Ask needed is absent from Investigate. Two copies guarantee continued drift.
- Recommendation: Extract `createPatchStream()` into lib/pipeline returning `{emit, emitProgress, keepalive, headers, response}` with `stateInitialized` semantics and one canonical header set.
- Verify: `grep -n "step === 1" src/app/api/query/route.ts` (currently line 183) and `grep -n "no-transform" src/app/api/query/investigate/route.ts` (currently no match).

**ARCH-3 · P2 · Warehouse materialize-to-CSV block duplicated across both routes**

- Evidence: route.ts:210-313 vs investigate/route.ts:294-415 — both do runWarehouseQuery → parseCSV → extractSchema → set source_type → storeCSV(randomUUID()) → emit `__warehouse_csv_id`. Investigate's copy additionally has the Parquet path (:344-377); Ask's does not.
- Issue: ~100 near-identical route lines; the Parquet improvement already exists in only one copy.
- Recommendation: Extract `materializeWarehouseResult({warehouse, connector, question, model, onProgress})` into lib/warehouse.
- Verify: `grep -n "extractSchema(parsed" src/app/api/query/route.ts src/app/api/query/investigate/route.ts` — currently 2 route-level hits; after fix, 0.

**ARCH-4 · P2 · Cost/diagnostics epilogue duplicated with divergent error-path semantics**

- Evidence: route.ts:539-573 vs investigate/route.ts:1118-1158 — identical getCostAccumulator → computeCost → emit \_\_cost → appendCostRow → writeRunDiagnostics blocks. Investigate's runs in `finally` (:1115); Ask's `clearInterval(keepalive)` at route.ts:577 is outside any finally.
- Issue: If the tracking wrappers reject in Ask, the keepalive interval leaks and no cost row is written; Investigate is protected.
- Recommendation: Extract `emitAndPersistCost(...)` in lib/cost; put Ask's keepalive cleanup in a finally.
- Verify: Check route.ts:577 `clearInterval` is not in a finally; after fix both routes call one shared helper.

**ARCH-5 · P1 · page.tsx is a 1,684-line god component** _(= FE-1; see FE-1 for the state split-brain detail)_

- Evidence: `Home()` spans page.tsx:73-1535 with 33 useState, 10 useEffect, 16 handler functions, plus two more components in-file (PreviewStrip:1556, RefreshProgress:1606). Largest file in the repo.
- Recommendation: Lift query submission + stream consumption into `useAnalysisRun`; export/menu cluster and schedule state into their own hooks; target Home < 400 lines.
- Verify: `wc -l src/app/page.tsx` (1684) and `grep -c "useState(" src/app/page.tsx`.

**ARCH-6 · P2 · LLM-provider knowledge leaks out of client.ts; two routes carry divergent provider lists**

- Evidence: route.ts:97-98 skips model validation for `ollama || openai-compatible` (not mlx/llama-cpp); investigate/route.ts:174 gates on `ollama || mlx || llama-cpp` (not openai-compatible). Provider dispatch inside client.ts spread over 3 sites (MODEL_MAP:765, switch:855-899, if-chain:1011-1035). `grep -rln "openai-compatible" src` → 7 files.
- Issue: Adding a provider is a 7-file shotgun edit; the two route lists have already diverged (mlx/llama-cpp Ask requests silently fall back to Claude model IDs in validation).
- Recommendation: Capability descriptor per provider in client.ts (`{skipModelValidation, ...}`); both routes query it.
- Verify: `grep -n "ollama" src/app/api/query/route.ts src/app/api/query/investigate/route.ts` — currently two different hardcoded lists.

**ARCH-7 · P2 · globalThis stores: lazy-only expiry, restart orphans on-disk files, single-process assumption undocumented** _(overlaps CORE-14, API-8, API-9)_

- Evidence: csv/storage.ts:7-18 (Map sole index); bytes in `tmpdir()/hermetic` (:21) cleaned only lazily inside getStoredCSV (:43-48). Same lazy pattern in warehouse/storage.ts:26, artifacts-cache.ts:42, code-cache.ts:24, conversation-cache.ts:26. Warehouse connectors closed only via removeWarehouse (:39-46).
- Issue: Restart empties the index → orphaned files accumulate forever; never-touched expired entries (incl. open DB connections) never reaped; single-process constraint documented nowhere.
- Recommendation: One shared sweeper (setInterval in instrumentation-node.ts) expiring all stores and unlinking orphans; document the constraint at the top of csv/storage.ts.
- Verify: `grep -rn "setInterval" src/lib/csv/storage.ts src/lib/warehouse/storage.ts src/lib/pipeline/*cache*.ts` — currently no matches.

**ARCH-8 · P2 · runPipeline has 15 positional parameters** _(= CORE-4)_

- Evidence: lib/pipeline/orchestrator.ts:59-75 (15 params, 12 optional). route.ts:437-453 passes `…, undefined, purpose`; investigate/route.ts:486-503 passes three trailing undefineds. Swapping `localMountPath`/`localFileContext`/`workbookContext` (all `string|undefined`) type-checks fine.
- Recommendation: `runPipeline(schema, csvContent, question, opts: PipelineOpts)` — style already used by runPipelineWithCode (orchestrator.ts:318-328).
- Verify: `grep -n "export async function runPipeline" -A 16 src/lib/pipeline/orchestrator.ts` — count params; after fix ≤ 4.

**ARCH-9 · P2 · Investigate stream handler is a ~930-line closure mixing 8 responsibilities**

- Evidence: investigate/route.ts:236-1170 — materialization (294-415), follow-up cost gate (464-522), planning (525-564), a ~150-line onProgress event switch building the audit trail (690-838), trace/artifacts caching (848-923), compose streaming with inline narrative scraping (984-1036), notebook-cell settlement (1044-1056), grounding (1064-1104), with mutable trail state threaded through closures.
- Issue: The audit-trail accumulation is pure lib logic; keeping it in the route makes it untestable except via HTTP.
- Recommendation: Extract a `TraceRecorder` into lib/pipeline/investigation-trace.ts; `ingestComposedLine` into a compose-capture module.
- Verify: `awk 'NR>=690 && NR<=838' src/app/api/query/investigate/route.ts | wc -l` (149-line switch inside the route today).

**ARCH-10 · P3 · Request-validation preamble duplicated between the two routes**

- Evidence: route.ts:116-155 vs investigate/route.ts:150-231 — identical 400s, identical warehouse 404 + connector 404, identical model/runtime ternaries.
- Recommendation: Shared `validateQueryRequest(context)`.
- Verify: `grep -n "Warehouse not found or expired" src/app/api/query/route.ts src/app/api/query/investigate/route.ts` — currently 2 copies.

**ARCH-11 · P3 · Adding a chart silently misses the spec-summary switch**

- Evidence: New chart = component + catalog.ts entry (auto-flows to composer prompt via catalog.prompt(), dashboard-compose.ts:497) + registry.tsx mapping — good 3-touch flow. But lib/spec-summary.ts has a separate 21-case switch (`case "BarChart"` at :48) not derived from the catalog.
- Issue: A new chart renders fine but silently degrades history summaries/follow-up context.
- Recommendation: Derive spec-summary handling from catalog metadata (`summaryKind` field) or add an exhaustiveness check.
- Verify: `grep -c "case \"" src/lib/spec-summary.ts` (21) vs catalog entries — nothing enforces sync.

**ARCH-12 · P3 · New warehouse connector requires edits in ~10 files, half UI**

- Evidence: `grep -rln "snowflake" src` (excl. snowflake.ts) → types.ts (union + config), connector.ts factory (:52-80), persist-env.ts (:99), sql-generation.ts dialect branches (:34,:48), 4 UI files, 2 API routes.
- Recommendation: Per-engine descriptor (dialect notes, form fields, env mapping) exported from each connector module.
- Verify: `grep -rln "snowflake" src --include="*.ts*" | grep -v __tests__ | wc -l` — currently 11 files.

**ARCH-13 · P3 · No client/server convention inside src/lib**

- Evidence: `"use client"` modules (theme-context, drill-down-context, chart-theme, theme-config) sit beside node-only modules (csv/storage imports fs; sandbox/warehouse import node built-ins) with no signal. The instrumentation split (instrumentation.ts:1-12) already fixed one bundler failure of this class.
- Recommendation: `lib/client/` (or `.client.ts` suffix) for client modules; `import "server-only"` in node-only stores.
- Verify: `grep -rln '"use client"' src/lib | grep -v __tests__` (4 files) and `grep -rn "server-only" src/lib` (0 matches today).

### 4.2 API layer & security (API)

> Posture note: the app binds 127.0.0.1 (start.sh:1109,1155) and has middleware rate-limiting + origin checks + security headers (middleware.ts:35-74). P2 items below become P0 if the app is ever hosted or bound to 0.0.0.0 — fix before any hosting story.

**API-1 · P2 (P0 if hosted) · local-files routes resolve arbitrary absolute paths → full filesystem read**

- Evidence: local-files/browse/route.ts:13-19 `const rawPath = searchParams.get("path") || getHomePath(); const dirPath = resolve(rawPath); await listDirectory(dirPath)`; same in select/route.ts:18, schema/route.ts:34. Only guard `validateLocalOrigin` returns true when Origin header absent (lib/local-files/security.ts:27).
- Issue: No root-jail — `/etc/passwd`, `~/.ssh` browsable. Origin check is browser-only; curl bypasses it.
- Recommendation: Allowlist of roots (home + explicitly chosen); assert resolved path is under an allowed root; make validateLocalOrigin fail closed.
- Verify: `grep -n "resolve(rawPath)\|validateLocalOrigin" src/app/api/local-files/*/route.ts`; after fix `curl 'http://127.0.0.1:3000/api/local-files/browse?path=/etc'` → 403.

**API-2 · P2 (P0 if hosted) · SSRF — remote-parquet/schema fetches any user URL server-side**

- Evidence: remote-parquet/schema/route.ts:34,60 passes url to extractRemoteParquetSchema → DuckDB httpfs fetch. isSafeParquetUrl (duckdb-source.ts:47-52) validates scheme + charset only, not host.
- Issue: `https://169.254.169.254/latest/meta-data/...`, localhost, internal hosts all pass — classic metadata-endpoint SSRF on hosted deploys.
- Recommendation: Host validation — reject link-local, loopback, RFC-1918, metadata hostnames; resolve DNS and re-check.
- Verify: `sed -n '47,52p' src/lib/parquet/duckdb-source.ts` — no host check today; after fix, unit test rejects `https://169.254.169.254/x.parquet`.

**API-3 · P2 · Generated + edited SQL executes with no read-only enforcement**

- Evidence: postgres.ts:174-175 `pool.query(sql)` as-is; bigquery.ts:216, clickhouse.ts:109 similar. sql-guard.ts checks sampling/joins, not statement type. Route accepts user `editedSql` (query/route.ts:90-91) passed straight through.
- Issue: Nothing forces SELECT-only; a hallucinated or user-supplied `DROP`/`DELETE` runs with the connection's full privileges.
- Recommendation: Read-only at the connector (Postgres `SET TRANSACTION READ ONLY`; BigQuery dry-run statementType) + shared single-statement SELECT/WITH check before executeSQL.
- Verify: `grep -n "READ ONLY\|statementType" src/lib/warehouse/*.ts` returns nothing today.

**API-4 · P2 · warehouse/sample interpolates unvalidated `table` into SQL; Snowflake branch unescaped**

- Evidence: warehouse/sample/route.ts:23,41-63 — `table` from searchParams, never checked against `warehouse.tables`; Snowflake branch (:57) `SELECT * FROM ${table} LIMIT 5` raw; the backtick-escaping for BigQuery/ClickHouse/Hive (`\``) is dialect-incorrect.
- Recommendation: Membership-validate `table` against stored `warehouse.tables`; use proper per-dialect identifier quoting.
- Verify: `sed -n '41,63p' src/app/api/warehouse/sample/route.ts`; confirm no membership guard exists.

**API-5 · P2 · Aborted/duplicate requests log request.json() failure as ERROR and return 500**

- Evidence: query/route.ts:64 `await request.json()` in the main try; outer catch :635-640 logs ERROR + returns 500. Same in investigate. 36 `await request.json()` sites across routes; none guard the parse.
- Issue: A client abort mid-body surfaces as "Unexpected end of JSON input" at ERROR severity + 500 — noise masking real errors (observed repeatedly in recent sessions).
- Recommendation: Own try around request.json(); parse failure → 400 + debug/warn log; short-circuit on `request.signal.aborted`.
- Verify: `grep -rn "await request.json()" src/app/api | wc -l` (36 sites, none guarded); after fix the two query routes return 400 on truncated body.

**API-6 · P3 · Internal error text leaked verbatim in JSON responses across most routes**

- Evidence: pervasive `error: err.message` returns — local-files/browse:22-23, select:64-65, schema:178-179, history/[id]:61-73, warehouse/connect:88-89, query:637. Exception: remote-parquet/schema:73 truncates to 300 chars.
- Recommendation: Small error helper: generic client message + server-side logged detail; consistent status mapping.
- Verify: `grep -rn "err instanceof Error ? err.message" src/app/api | wc -l`.

**API-7 · P3 · No input schema validation anywhere — 40 routes hand-parse `body as {...}`**

- Evidence: zero zod/safeParse hits in src/app/api; e.g. local-files/select:12 casts body then only null-checks; warehouse/connect:11 casts entire body to WarehouseConnectionConfig checking only `config.type`.
- Recommendation: zod schemas per route body (zod already a dep via catalog.ts); start with warehouse/connect, local-files/\*, remote-parquet.
- Verify: `grep -rln "from \"zod\"" src/app/api` (currently empty).

**API-8 · P3 · Warehouse credentials plaintext on disk; in-memory connectors only lazily reaped**

- Evidence: persist-env.ts:35,59,71 writes full config incl. password/s3SecretAccessKey to `.warehouse-connections.json` (gitignored — good); live connector pools evicted only on lazy TTL check (warehouse/storage.ts:26-30).
- Recommendation: Document plaintext storage; 0600 perms (or keychain); periodic sweep closing expired connectors.
- Verify: `grep -n "password\|SecretAccess" src/lib/warehouse/persist-env.ts`; `ls -la .warehouse-connections.json`.

**API-9 · P3 · Unbounded disk growth — history never pruned; TTL'd temp CSVs orphaned**

- Evidence: history/storage.ts:83-123 saveHistoryEntry writes meta/spec/code/schema/artifacts/source.csv per run, no cap (`grep MAX_HISTORY|prune|retention` → none). tmpdir/hermetic files unlinked only on lazy re-access (csv/storage.ts:43-48).
- Recommendation: Cap history to N entries (prune on save) or age/size budget; startup/periodic mtime sweep of tmpdir/hermetic.
- Verify: `grep -rn "prune\|MAX_HISTORY\|retention" src/lib/history` (empty); `du -sh data/history` over time.

**API-10 · P3 · Streaming scaffold duplication** → _merged into ARCH-2 (WS1)._

### 4.3 Core engine (CORE)

**CORE-1 · P2 · ~250 lines duplicated between ollamaFetch and localOpenAIFetch**

- Evidence: client.ts — ollamaFetch :37-372 (336 lines), localOpenAIFetch :386-759 (374 lines). Responses-API SSE synthesis near-identical at :161-295 vs :580-758; non-streaming translation identical :118-151 vs :544-569. Already drifted: localOpenAIFetch has stall-timeout + error-as-text (:629-708); ollamaFetch's version (:243-245) silently swallows stream errors.
- Recommendation: Extract `translateToResponsesSSE(upstream, parseChunk, opts)` + `buildResponsesJSON(text, usage)`; both shims become <100-line adapters.
- Verify: `grep -n "response.output_item.done" src/lib/llm/client.ts` → currently 2 hits (:271, :734); after fix, 1.

**CORE-2 · P2 · Sandbox output parsing copy-pasted 4× with behavioral drift (OOM detection only in Docker path)**

- Evidence: parse block exists in docker-utils.ts:99-167, microsandbox-executor.ts:368-432, executor.ts (e2b) ~65-115, microsandbox-warm-backend.ts:~135-180. `grep -rn "Code produced no output" src/lib/sandbox` → 8 hits/4 files. Only docker-utils.ts:80-90 detects exit-137/"Killed" as OOM with actionable guidance.
- Issue: Contract fixes land in one runtime and silently not others; microsandbox/e2b get a worse error for the identical failure.
- Recommendation: Runtime-agnostic `parseSandboxOutput(readFile, exitCode, stderr, start): ExecutionResult`; all four call it.
- Verify: `grep -rn "Failed to parse output as JSON" src/lib/sandbox/*.ts | wc -l` → currently 4; after fix, 1.

**CORE-3 · P2 · microsandbox executeSandbox inlines the chunked-write loop 4× while writeChunkedFile sits unused in the same file**

- Evidence: microsandbox-executor.ts:211-244, 246-278, 280-321, 326-339 each hand-roll the base64 chunk loop (~110 lines); `writeChunkedFile` at :457-489 implements exactly this ("Exported for reuse") but is unused by its own file. CHUNK_SIZE defined twice (:212, :462).
- Verify: `grep -c "b64decode" src/lib/sandbox/microsandbox-executor.ts` → currently 9; after fix ≤ 3.

**CORE-4 · P2 · runPipeline 15 positional params** → _merged into ARCH-8 (WS5)._

**CORE-5 · P2 · LLM/sandbox JSON boundary is cast-and-pluck — 71 `as Record<string, unknown>` casts**

- Evidence: `grep -rc "as Record<string, unknown>" src/lib` → 71, clustering in dashboard-compose.ts (9), resolve-placeholders.ts (7), rehydrate-spec.ts (6), investigate-composer.ts (5), investigate-planner.ts (4). ExecutionResult assembly casts unvalidated JSON (docker-utils.ts:158-165, ×4 executors). zod imported exactly once in src/lib (catalog.ts:3).
- Issue: The two most failure-prone boundaries have no runtime schema check; a model emitting `datasets: "none"` flows typed-as-object into downstream code, erroring far from the cause.
- Recommendation: zod schemas for the sandbox output envelope and planner/replanner/gap-check JSON at the shared parse points; rejects feed existing retry loops.
- Verify: `grep -rn "from \"zod\"" src/lib --include="*.ts" | grep -v catalog` → currently 0; after fix ≥ 2.

**CORE-6 · P2 · getOrCreateSandbox has a check-then-act race on module-level mutable state**

- Evidence: microsandbox-executor.ts:15-16 boolean pair; :77-87 null-check → multi-second async create before assignment (:178). No promise memoization — contrast warm-sandbox.ts:65-73 which dedupes via warmupPromise. Also executeSandbox's catch (:433-439) stops the shared sandbox on ANY error, killing a concurrent query's sandbox.
- Recommendation: Memoize a creationPromise exactly like warm-sandbox.ts; scope the catch-reset to pre-query-phase errors.
- Verify: Read microsandbox-executor.ts:77-87 — presence of a `Promise<PythonSandbox>` memo instead of the boolean pair confirms the fix.

**CORE-7 · P3 · Error taxonomy: control flow keyed on error-message substrings**

- Evidence: 83 bare `} catch {` in src/lib (mostly justified best-effort); only 2 error classes (ApiError, EnvError) vs 56 inline `new Error(`. Load-bearing string couplings: orchestrator.ts:171 `/timed out/i` ← docker-utils.ts:21 message; sql-generation.ts:284-288 regex; client.ts:685 `.includes("ECONNRESET")`.
- Recommendation: Small error module (SandboxTimeoutError, ResourceLimitError, LLMConnectionError) for the 3-4 messages that drive control flow.
- Verify: `grep -rn "timed out" src/lib/sandbox/docker-utils.ts src/lib/pipeline/orchestrator.ts` — string coupling at docker-utils.ts:21 ↔ orchestrator.ts:171; after fix, instanceof.

**CORE-8 · P3 · Timeout constants contradict their own comments/error text; 27 inline timeoutMs literals**

- Evidence: client.ts:377-378 `LOCAL_STREAM_STALL_TIMEOUT_MS = 5 * 60_000` but comment at :632-633 and user-facing error at :638 say "60 seconds" — 5× wrong. 27 inline `timeoutMs:` literals; MAX_RETRIES=3 inline (orchestrator.ts:145); CONTAINER_LIFETIME (docker-warm-backend.ts:9).
- Recommendation: Interpolate the constant into the stall message; move recurring exec budgets into constants.ts.
- Verify: `grep -n "60 seconds" src/lib/llm/client.ts` → hits :638 today; after fix, 0.

**CORE-9 · P3 · Complexity hotspots: 395/374/336/250/237-line functions**

- Evidence: buildDashboardComposeRequest (dashboard-compose.ts:86-480, 395 lines); localOpenAIFetch (374); ollamaFetch (336); runPipeline (~250 incl. inline retry loop); runInvestigation (investigate-orchestrator.ts:788-1024, 237). Ten largest lib files: catalog.ts 1285, client.ts 1089, investigate-orchestrator.ts 1024, api.ts 754, prompts.ts 744, investigate-planner.ts 698, process-manager.ts 692, dashboard-compose.ts 682, investigate-composer.ts 611, csv/schema.ts 584.
- Recommendation: Split buildDashboardComposeRequest into per-section builders (natural seams exist); extract runPipeline's retry loop.
- Verify: `awk 'NR>=86 && NR<=480' src/lib/pipeline/dashboard-compose.ts | wc -l` → 395 today.

**CORE-10 · P3 · Dead exports: buildRetryPrompt, buildCodeGenChatPrompt, warmupSandbox**

- Evidence: buildRetryPrompt (prompts.ts:673) referenced only by its own tests — test-pinned dead code (production uses buildRetryPromptMulti); buildCodeGenChatPrompt (prompts.ts:573) 0 refs; warmupSandbox (microsandbox-executor.ts:187) 0 refs.
- Recommendation: Delete all three + buildRetryPrompt's test block; port unique assertions to buildRetryPromptMulti tests.
- Verify: `grep -rn "buildRetryPrompt\b\|buildCodeGenChatPrompt\|warmupSandbox" src --include="*.ts" --include="*.tsx"` → only defs+tests today; after fix, 0.

**CORE-11 · P3 · csvValue + rows→CSV serialization duplicated across 5 warehouse connectors**

- Evidence: identical `csvValue` in postgres.ts:15, databricks.ts:24, snowflake.ts:26, hive.ts:13, trino.ts:11; header+rows loop repeats. ClickHouse diverges (server-side CSVWithNames, clickhouse.ts:112) so escaping semantics may already differ.
- Recommendation: `rowsToCsv(headers, rows)` in warehouse/connector.ts; delete 5 copies.
- Verify: `grep -rn "function csvValue" src/lib/warehouse` → 5 hits today; after fix, 1.

**CORE-12 · P3 · `\bNaN\b → null` regex over raw JSON can corrupt legitimate string data (6 copies)**

- Evidence: `outputJson.replace(/\bNaN\b/g, "null")` in docker-utils.ts:143, microsandbox-executor.ts:408, executor.ts:94, microsandbox-warm-backend.ts:167, parquet/materialize.ts:115, parquet/schema-extractor.ts:69.
- Issue: Runs over string values too — `"NaN Zhu"` → `"null Zhu"` in user-visible results. PYTHON_NAN_PRELUDE already emits JSON-safe output; the regex is an unconditional legacy belt.
- Recommendation: Parse first; regex only as fallback when JSON.parse throws (bare NaN is invalid JSON so failure is detectable); centralize in the CORE-2 shared parser.
- Verify: `node -e 'console.log(JSON.stringify({n:"NaN Zhu"}).replace(/\bNaN\b/g,"null"))'` demonstrates corruption; after fix, a unit test with that fixture passes.

**CORE-13 · P3 · The repo's only `any` usage clusters in Hive/Databricks connectors**

- Evidence: repo-wide `: any`/`as any` = 5 (excellent): databricks.ts:44,49, hive.ts:24, client.ts:540. `as unknown as T[]` row casts at databricks.ts:73, snowflake.ts:72 make executeQuery<T> an assertion, not a contract.
- Recommendation: Minimal structural interfaces for the driver sessions (~10 lines each).
- Verify: `grep -rn ": any\|as any" src/lib --include="*.ts" | grep -v __tests__ | wc -l` → 5 today; after fix 0-1.

**CORE-14 · P3 · Module-level caches evict only on read — unbounded growth; conversation cache keyed by csvId alone** _(overlaps ARCH-7)_

- Evidence: conversation-cache.ts:23-31 TTL checked only in getConversationTurns; 7 globalThis caches total. Key is csvId only → two tabs/users on the same dataset interleave conversation history.
- Recommendation: Lazy sweep on Nth write or LRU cap; include a session identifier in the key where sessions exist.
- Verify: `grep -n "delete" src/lib/pipeline/conversation-cache.ts` → deletion only in get/clear paths today.

**CORE-15 · P3 · Runtime capability drift: microsandbox/e2b silently lack large-data timeout, mount/Parquet support, OOM guidance**

- Evidence: docker honors LARGE_DATA_TIMEOUT_MS via codeDoesRemoteIo (docker-executor.ts:27-28); microsandbox-executor.ts:342 always uses SANDBOX_TIMEOUT_MS (30s) and its signature omits localMountPath/inputParquetPath; e2b likewise. index.ts:210-217 guards mount/Parquet to docker, but remote-IO code is NOT guarded — on microsandbox it just times out at 30s.
- Recommendation: Apply codeDoesRemoteIo → extended timeout in microsandbox/e2b, or extend the index.ts:210 guard to reject remote-IO on non-docker runtimes with an actionable message.
- Verify: `grep -n "codeDoesRemoteIo\|LARGE_DATA_TIMEOUT" src/lib/sandbox/microsandbox-executor.ts src/lib/sandbox/executor.ts` → 0 hits today.

**CORE-16 · P3 · `as unknown as Spec` cast repeated at three history call sites**

- Evidence: history/storage.ts:101, history/persist.ts:68, conversation-cache.ts:81 (+storage.ts:102 for extractDescription).
- Recommendation: summarizeSpec/extractDescription accept `Record<string, unknown>`, or one `asSpec(raw)` adapter with a structural check.
- Verify: `grep -rn "as unknown as Spec" src/lib | wc -l` → 4 today; after fix, 0.

### 4.4 Frontend (FE)

**FE-1 · P1 · page.tsx god component with split-brain reducer/useState** _(= ARCH-5)_

- Evidence: 1,684 lines; 33 useState, 10 useEffect, 21 useCallback, 7 useRef, plus a usePageState reducer. Lockstep state lives outside the reducer: `setRefreshStage("loading")` beside `dispatch({type:"RERUN_START"})` at :304-318 and :583-602; `setLoadedVizId` beside LOAD_VIZ_SUCCESS-family dispatches at :531, :562, :597.
- Issue: Rerun/load lifecycle invariants maintained manually at 6+ sites; a missed `setRefreshStage(null)` in any catch leaves a stuck spinner.
- Recommendation: Fold refreshStage/loadedVizId/lastCompleteSpec/analysisHistory into pageReducer; extract useHistoryRestore, useSuggestions hooks alongside the existing seam.
- Verify: `wc -l src/app/page.tsx`; compare :304-318 pairing with src/hooks/use-page-state.ts:124-147.

**FE-2 · P1 · Dead duplicated useSaveExport/useArtifacts inside ResponsePanel**

- Evidence: response-panel.tsx:284-298 destructures 7 values from useSaveExport — zero usages beyond the destructure (comment at :776: "moved to top bar — see page.tsx"). From useArtifacts, artifactsLoading/artifactsError/handleToggleArtifacts also unused. page.tsx instantiates its own instances (:201-215, :218) with a _different_ csvId input (page uses csvId; panel uses effectiveCsvId); both layers keep separate dashboardRefs.
- Recommendation: Delete the dead panel instance; keep only artifacts/setArtifacts/showArtifacts (or lift artifacts fully to the page, which already receives effectiveCsvId).
- Verify: `grep -n "handleSave\|handleExportPdf\|saveMessage\|artifactsError\|handleToggleArtifacts" src/components/app/response-panel.tsx` — only the destructure lines today.

**FE-3 · P2 · No memoization anywhere on the stream-patch render path**

- Evidence: `grep -rn "memo(" src/components --include="*.tsx" | grep -v useMemo` → 0 hits. useUIStream updates spec per patch; `<Renderer spec={activeSpec}/>` (response-panel.tsx:768) re-renders the whole tree each patch. Charts recompute O(rows) transforms per render (bar-chart.tsx:61-77, :120-122; line-chart.tsx:65) — none behind useMemo.
- Recommendation: React.memo chart components (plain-JSON props; JSON.stringify-keyed comparator mirrors data-controller's pattern); useMemo per-chart transforms keyed on props.data.
- Verify: `grep -rn "React.memo\|useMemo" src/components/charts/bar-chart.tsx src/components/charts/line-chart.tsx` → none today.

**FE-4 · P2 · Drill-down callback effect masks a stale-closure bug via exhaustive-deps disable**

- Evidence: response-panel.tsx:447-448 disable; deps `[effectiveCsvId, warehouseId, send]` but the callback sends schemaMode, codeGenModel, uiComposeModel, sandboxRuntime, purpose, viewMode (:435-440).
- Issue: Changing model/purpose/runtime in settings after mount → subsequent drill-downs send stale values until effectiveCsvId happens to change. Real behavioral bug.
- Recommendation: Add the config values to the deps (the effect is a cheap ref reassignment) or read them via a useLatest ref helper.
- Verify: `sed -n '360,448p' src/components/app/response-panel.tsx` — compare captured vars vs dep array.

**FE-5 · P2 · deckgl-init.ts permanently monkey-patches console.error and window.onerror app-wide**

- Evidence: deckgl-init.ts:26-34 replaces window.onerror; :42-62 capture-phase listeners with stopImmediatePropagation; :67-74 replaces console.error dropping ANY call whose args stringify to include "maxTextureDimension2D". Loaded on first Map3D render, never restored. Third overlapping layer above the clean, tested patch-resize-observer.ts.
- Recommendation: Keep the ResizeObserver patch; drop or dev-gate the console.error/window.onerror patches (stated motivation is the Next dev overlay).
- Verify: `sed -n '21,75p' src/lib/deckgl-init.ts`; `grep -rn "deckgl-init" src --include="*.tsx"` → only map3d-inner.tsx:4.

**FE-6 · P2 · Save failures from the top bar are silent**

- Evidence: useSaveExport reports failure only via saveMessage (use-save-export.ts:66), but page.tsx doesn't destructure saveMessage (0 hits); export failures are console.error only (:80). The one saveMessage consumer is the dead instance (FE-2).
- Recommendation: Surface saveMessage + export error next to the top-bar controls or via toast.
- Verify: `grep -n "saveMessage" src/app/page.tsx` → no matches today.

**FE-7 · P2 · Charts render a silent blank box on empty data**

- Evidence: 15 charts early-return a bare sized div (bar-chart.tsx:129-131; line-chart.tsx:81-83; map3d-view.tsx:64-66). `grep -rn "No data" src/components/charts` → 0.
- Issue: A wrong LLM key produces an unexplained empty region, indistinguishable from a bug — while crashes get labeled fallbacks.
- Recommendation: Shared `<ChartEmptyState height/>` used in all 15 early returns.
- Verify: `grep -rn "data.length === 0" src/components/charts --include="*.tsx" | wc -l` → 15.

**FE-8 · P2 · Chart interactions mouse-only; hover-revealed controls invisible to keyboard users**

- Evidence: drill/select is nivo onClick on SVG (bar-chart.tsx:219-234), no keyboard path; chart action buttons `opacity-0 group-hover:opacity-100` (chart-expand-wrapper.tsx:138) with 0 focus styles; onKeyDown appears 5× in all of src/components; charts dir has 6 aria/role vs 95 elsewhere.
- Recommendation: `group-focus-within:opacity-100 focus-visible:opacity-100` on hoverVisible; keyboard path for drill (focusable alternative or menu); `role="img"` + aria-label on chart containers.
- Verify: `grep -n "hoverVisible\|focus" src/components/charts/chart-expand-wrapper.tsx`; `grep -rn "onKeyDown" src/components/charts` → 0.

**FE-9 · P3 · Hardcoded hex colors bypass the theme-token system in app components**

- Evidence: 104 `#rrggbb` across 34 files; 57 outside charts/. Self-inconsistent: response-panel.tsx:1097-1099 inlines #d97706/#b45309 while the same file uses warning tokens at :738.
- Recommendation: Replace inline hex in app components with existing tokens; reserve raw hex for chart palettes in chart-theme.ts.
- Verify: `grep -rno "#[0-9a-fA-F]\{6\}" src/components --include="*.tsx" | grep -v "/charts/" | wc -l` → 57 today.

**FE-10 · P3 · Debug console noise shipped in page.tsx**

- Evidence: 16 console.log/warn — `[follow-up]` trace logs at :704-741, :759, :1452-1456; no env gating; logger.ts unused here.
- Recommendation: Route through logger with a debug flag, or delete now the drop diagnosis shipped.
- Verify: `grep -c "console.log\|console.warn" src/app/page.tsx` → 16 today.

**FE-11 · P3 · registry.tsx is 750 lines of mechanical repetition**

- Evidence: 60 near-identical dynamic() declarations (:76-314) + ~50 identical ChartExpandWrapper entries (:427-692); only BarChart/PieChart got the selection-bridge treatment (:371-416) — intent or omission unclear.
- Recommendation: `lazyChart(loader)` + `simpleChart(Component)` factories; selection support becomes an explicit option.
- Verify: `wc -l src/components/registry.tsx` → 751; `grep -c "ChartExpandWrapper title={props.title}" src/components/registry.tsx`.

**FE-12 · P3 · Per-chart scaffold copy-pasted; no ChartShell**

- Evidence: identical title block (bar :137-149 vs line :89-98 vs map3d :72-79); legendItemWidth duplicated with different maxes (200 vs 180); truncateLabel duplicated. chart-stats.ts imported by only 3 charts.
- Recommendation: `ChartShell({title, drillable, selectable, height, children})` next to chart-expand-wrapper; move truncateLabel/legendItemWidth into chart-theme.ts.
- Verify: `diff <(sed -n '137,149p' src/components/charts/bar-chart.tsx) <(sed -n '89,98p' src/components/charts/line-chart.tsx)` — near-identical.

**FE-13 · P3 · Two page.tsx suggestion effects rely on schemaKey as a proxy for schema contents**

- Evidence: 11 exhaustive-deps disables total; sampled — data-controller.tsx:87-109 legitimate (documented stabilization); page.tsx:745/:861 read schema/warehouse.tableSchemas under only [schemaKey].
- Recommendation: Derive the request body in a useMemo keyed on actual inputs; drop the disable.
- Verify: `grep -rn "react-hooks/exhaustive-deps" src/components src/app` → 11; inspect page.tsx:819-862.

### 4.5 Observability (OBS)

**OBS-1 · P1 · No run/request correlation ID anywhere**

- Evidence: `grep -rn "runId\|requestId\|correlationId\|traceId" src` → 0 hits. All 160 logger calls carry only free-text + local meta; diagnostics JSONL and cost CSV correlate only by timestamp.
- Issue: Concurrent multi-minute runs interleave in the log with no attribution — exactly the pain in recent debugging. Cost row ↔ diagnostics ↔ log lines ↔ history entry cannot be joined.
- Recommendation: Short runId at route entry, in an AsyncLocalStorage context read by logger.formatMessage; include in diagnostics record, cost row, history entry.
- Verify: `grep -rn "runId" src/lib/logger.ts src/lib/diagnostics/run-diagnostics.ts src/lib/cost/storage.ts` — all three after fix.

**OBS-2 · P1 · LLM calls outside the two main routes are not cost-tracked**

- Evidence: runWithCostTracking only in query/route.ts:207, investigate/route.ts:275, compose-cell/route.ts:94. suggest/route.ts:172,206 calls getModel() directly; recompose/route.ts:84 and rerun-step run composer calls untracked. recordCall() silently no-ops outside a scope (accumulator.ts:106-107).
- Issue: Suggest fires after every analysis; the cost breakdown (a stated project priority) undercounts.
- Recommendation: Wrap suggest/recompose/rerun-step (+ refresh routes that regenerate code) in runWithCostTracking + appendCostRow with distinct modes.
- Verify: `grep -rln "getModel\|composeInvestigation\|composeStepCell" src/app/api | xargs grep -L runWithCostTracking` → empty after fix.

**OBS-3 · P2 · Dev log format has no timestamps**

- Evidence: logger.ts:24-36 — `ts` only in the isProd JSON branch; dev format is `[LEVEL] message {meta}`.
- Issue: The team debugs multi-minute pipelines from dev logs; latency/gap reconstruction is impossible.
- Recommendation: Add a time prefix to the dev branch of formatMessage.
- Verify: `sed -n '33,35p' src/lib/logger.ts` shows a time component after fix.

**OBS-4 · P2 · Client-side diagnostics are browser-console-only; no client→server log bridge**

- Evidence: 31 client console.\* calls (page.tsx 24, response-panel.tsx:259,462 incl. the mid-stream-abort diagnostics from commits b62fb0d/38392ed); no /api/client-log or telemetry endpoint exists.
- Issue: The abort diagnostics exist only if devtools were open at failure time; they never reach server logs.
- Recommendation: Tiny `POST /api/client-log` forwarding {level,msg,meta} into logger (fire-and-forget, sendBeacon on unload); route the [ResponsePanel]/[follow-up] warns through it.
- Verify: `ls src/app/api/client-log/route.ts` and `grep -rn "client-log" src/components/app/response-panel.tsx` after fix.

**OBS-5 · P2 · No stage durations — only sandbox execution_ms; sub-question timing fields are dead writes**

- Evidence: execution_ms measured only in parseExecutionOutput (docker-utils.ts:65). No Date.now() deltas around code-gen/compose. investigate-orchestrator.ts:537,593,626 set slot.startedAt/finishedAt — zero readers. Cost CSV has no duration column; diagnostics record has no timing fields.
- Recommendation: durationMs per phase alongside existing withPhase labels; wallMs into StepDiag from the existing slot timestamps; duration_ms column in cost rows.
- Verify: `grep -n "durationMs\|wallMs" src/lib/diagnostics/run-diagnostics.ts src/lib/cost/storage.ts` non-empty; `grep -n "finishedAt" src/lib/pipeline/investigate-orchestrator.ts` shows a read.

**OBS-6 · P2 · Stack traces and error causes never logged — 111 flatten sites, 0 stacks**

- Evidence: `grep -rE "instanceof Error \? .{0,20}\.message" src` → 111; `grep -rn "logger\..*stack" src` → 0; cause chain discarded everywhere (e.g. query/route.ts:635).
- Recommendation: serializeError(err) helper (message + name + ~5 frames + cause?.message) at terminal logger.error sites.
- Verify: `grep -rn "serializeError" src/app/api/query/route.ts src/lib/pipeline/orchestrator.ts` after fix; `grep -rn "logger\..*stack" src | wc -l` > 0.

**OBS-7 · P2 · Diagnostics JSONL has no in-app reader; its own write failure logged at debug**

- Evidence: data/diagnostics/<date>.jsonl written at run-diagnostics.ts:200-204; no route or lib reads it (cost has listCostRows + /api/cost; diagnostics has nothing). Write failure logged at debug (:206) — invisible at default prod level.
- Recommendation: listRunDiagnostics() + small API route mirroring cost storage; raise write-failure to warn.
- Verify: `grep -rn "diagnostics" src/app/api` non-empty after fix; run-diagnostics.ts:206 uses logger.warn.

**OBS-8 · P2 · Failed/expired runs lose their investigation trail**

- Evidence: Trace built at investigate/route.ts:848 lives in the in-memory artifacts cache; reaches disk only via persistHistoryEntry. persist.ts:31-34 silently skips (debug) when the CSV entry expired; restart or pre-persist crash drops the trail.
- Issue: The runs you most need to post-mortem are the least likely to leave a trail.
- Recommendation: On run failure, write the partial trace (steps + errors + code refs) into the diagnostics record or data/diagnostics/failed-runs/.
- Verify: Force a compose failure; check data/diagnostics/<date>.jsonl contains per-step code/error for that run.

**OBS-9 · P3 · \_\_progress stage transitions never logged/persisted server-side**

- Evidence: emitProgress (query/route.ts:181-192, investigate/route.ts:250-266) only enqueues stream patches; no logger/diagEvent accompanies transitions. Disconnect log gives elapsedMs but not stage.
- Recommendation: `diagEvent("stage", {stage, step})` inside emitProgress — one line, lands in the run's JSONL.
- Verify: `grep -n "diagEvent" src/app/api/query/route.ts` shows a call inside emitProgress after fix.

**OBS-10 · P3 · Sandbox failure discards stdout; timeout keeps only last 10 stderr lines; neither persisted**

- Evidence: docker-utils.ts:68-96 — on nonzero exit only stderr.txt read; stdout.txt never fetched on failure. Timeout path (docker-executor.ts:126) truncates to slice(-10). Captured text lives only in the transient error string.
- Recommendation: On failure also read stdout.txt; record {stderrHead, stderrTail, stdoutTail, exitCode} via diagEvent("sandbox_failure", …).
- Verify: `grep -n "stdout.txt" src/lib/sandbox/docker-utils.ts` shows a read in the exitCode !== 0 branch after fix.

**OBS-11 · P3 · Full generated code and full SQL logged at info; logger has no redaction/truncation facility**

- Evidence: orchestrator.ts:115-117 `{fullCode: code}` at info; query/route.ts:274 logs full SQL. No credential logging found (clean). logger.ts has no redaction.
- Recommendation: Truncate fullCode/sql meta to ~2KB; small key-denylist redactor (password|apiKey|token|secret) in formatMessage.
- Verify: `grep -n "redact\|slice(0" src/lib/logger.ts` non-empty after fix.

**OBS-12 · P3 · Zero logging in warehouse connectors, pipeline caches, code-generation.ts**

- Evidence: per-file logger counts: all 7 connectors + connector.ts + sql-guard.ts = 0; code-cache/conversation-cache/artifacts-cache = 0 (evictions silent); code-generation.ts = 0.
- Recommendation: logger.debug on cache evict/expire; logger.warn with driver context in connector error paths (or in the shared runWarehouseQuery chokepoint).
- Verify: `for f in src/lib/warehouse/bigquery.ts src/lib/pipeline/code-cache.ts; do grep -c logger $f; done` both > 0 after fix.

**OBS-13 · P3 · Cost CSV append is read-modify-write with an acknowledged race**

- Evidence: cost/storage.ts:5-9 comment admits "small race on concurrent appends"; appendCostRow (:68-81) does readFile→parse→rewrite whole file — the exact pattern run-diagnostics.ts:3-7 says lost most rows in its predecessor.
- Recommendation: Atomic single-line append (JSONL or pre-serialized CSV line + appendFile), same as run-diagnostics.
- Verify: `grep -n "appendFile" src/lib/cost/storage.ts` present after fix; no readFile inside appendCostRow.

### 4.6 Testing (TEST)

Fresh coverage measured during review: global 31.9% lines (gate 25); src/lib 51.1% lines (gate 43). Highest-risk untested files (size × criticality): client.ts 1,089 lines @ 4.9%; investigate/route.ts 1,193 @ 10.9%; query/route.ts 642 @ 19.9%; microsandbox-executor.ts 491 @ 2.5%; orchestrator.ts 354 @ 7.0%; docker-executor.ts 143 @ 0%; scheduler.ts 92 @ 0%; upload/route.ts 73 @ 0%; excel/parser.ts 87 @ 0%; middleware.ts 33 @ 0%.

**TEST-1 · P1 · Test suite is red at HEAD** — see IMMEDIATE (§1). Commit 34d548f rewrote prompt guidance without updating 2 pinned assertions (prompts.test.ts:~100).

- Verify: `npx vitest run src/lib/llm/__tests__/prompts.test.ts` → 0 failures after fix.

**TEST-2 · P1 · LLM provider core (client.ts) 4.9% covered**

- Evidence: 15/304 lines covered; only isAdaptiveOnlyModel and cachedSystem tested. Provider detection, model routing, Bedrock/Vertex/OpenAI-compat construction, retry/stream handling untested.
- Recommendation: Extract/inject SDK constructors; unit-test provider auto-detect, model-id resolution per provider, retry/param-strip paths.
- Verify: `npx vitest run --coverage` → client.ts lines % > 43 (the lib gate).

**TEST-3 · P1 · Sandbox execution layer effectively untested (10.5% lines)**

- Evidence: src/lib/sandbox 50/478 lines; docker-executor 0%, microsandbox-executor 2.5%, index 16.7%. Container arg construction, output.json fallback chain (docker-utils.ts:103-111), timeout escalation (docker-executor.ts:27-28) unverified.
- Recommendation: Stub `run()` (already injectable-shaped); assert exact docker arg sequences (mount vs docker cp vs stdin) and the retrieval fallback chain.
- Verify: `npx vitest run src/lib/sandbox --coverage` → docker-executor.ts > 0%.

**TEST-4 · P2 · API route layer 5.9% covered; ~34 routes at 0%**

- Evidence: src/app/api aggregate 135/2287 lines; only 6 route dirs have any test; the two tested query routes cover only pre-pipeline validation by design (route.test.ts:3-10).
- Recommendation: Replicate the validation-contract pattern for upload, rerun, local-files first (same mocking recipe); then one happy-path per route with mocked lib.
- Verify: coverage-summary src/app/api aggregate > 20%.

**TEST-5 · P2 · No tests for the streaming/NDJSON protocol despite recent mid-stream-abort bugs**

- Evidence: `grep -rln "NDJSON\|ReadableStream\|TextDecoder" src --include="*.test.*"` → 0. Recent commits (55f1427, 38392ed) fight streaming bugs; response-panel (consumer) 0%.
- Recommendation: Protocol test feeding scripted split-chunk NDJSON into the client parser; route-side event-sequence test with mocked orchestrator.
- Verify: the grep above returns ≥1 after fix.

**TEST-6 · P2 · Generated-Python contract only regex-pinned — prelude never executed**

- Evidence: prelude.test.ts (30 lines) asserts PYTHON_NAN_PRELUDE matches regexes; write_output NaN sanitization, safe_qcut, to_num never actually run.
- Recommendation: Opt-in test (skipped when python3 absent) piping PYTHON_NAN_PRELUDE + fixture through `python3 -`, asserting emitted output.json.
- Verify: prelude.test.ts contains an executed-Python case.

**TEST-7 · P2 · No e2e framework; the only e2e artifact is a manual script outside CI**

- Evidence: no playwright/cypress config; scripts/e2e-investigate.ts requires a hand-started server (E2E_BASE_URL); CI never invokes it; spec/testing/ holds 14 manual test-plan markdowns.
- Recommendation: One Playwright smoke: upload fixture CSV, canned question against a local mock LLM (via OPENAI_BASE_URL), assert a dashboard renders; run in CI.
- Verify: `ls playwright.config.ts` exists; CI has an e2e job.

**TEST-8 · P3 · Commit/push gates run no tests or type-check**

- Evidence: .husky/pre-commit = lint-staged (eslint+prettier only); no pre-push hook. This is exactly how TEST-1 happened.
- Recommendation: .husky/pre-push running `pnpm type-check && pnpm test` (suite is ~18s).
- Verify: `cat .husky/pre-push` exists and runs vitest.

**TEST-9 · P3 · Prompt tests pin verbatim prose from a high-churn 744-line prompt file**

- Evidence: prompts.test.ts:74-100 uses exact-phrase toContain; 5 prompt-copy commits in the last week; one broke the suite (TEST-1).
- Recommendation: Pin structural invariants (section headers, block presence/absence, mutually-exclusive branches) via stable sentinels or exported section constants.
- Verify: Reword a guidance sentence → suite green; delete the bbox section → suite red.

**TEST-10 · P3 · Ask-path orchestrator at 7% while investigate-orchestrator is at 97%**

- Evidence: orchestrator.ts 5/71 lines vs investigate-orchestrator 96.8% (959-line test proves the pattern works here).
- Recommendation: Mirror the approach: mock generateCode + executeSandbox; assert retry counts, prompt escalation, degraded propagation.
- Verify: coverage for orchestrator.ts > 60%.

**TEST-11 · P3 · Scheduler and scheduled-rerun path 0% covered**

- Evidence: saved/scheduler.ts 0/92; vizs/[id]/rerun 0/111; refresh 0/56. Only schedule storage is tested.
- Recommendation: Fake-timer tests (pattern exists in code-cache.test.ts): due-detection, overlap suppression, failure backoff.
- Verify: `npx vitest run src/lib/saved` covers scheduler.ts > 0%.

**TEST-12 · P3 · Coverage report vanishes on a red run; stale local artifacts mislead**

- Evidence: v8 reportOnFailure defaults false — a failing `vitest run --coverage` clears coverage/ and writes nothing; the local summary found during review was 18 days / 131 commits stale.
- Recommendation: `coverage.reportOnFailure: true` in vitest.config.ts.
- Verify: Break one test, run `pnpm test:coverage`, confirm coverage-summary.json still exists.

### 4.7 Documentation (DOC)

**DOC-1 · P1 · README claims "no network access" for sandboxed code — false for the default Docker runtime** — see IMMEDIATE (§1).

- Evidence: README.md:27 vs docker-executor.ts:34-38 (`docker run` with no `--network none`; codebase deliberately supports in-sandbox S3 reads via codeDoesRemoteIo, :25-28).
- Recommendation: Rewrite the claim ("network access is available for remote data sources; use microsandbox/E2B for stricter isolation"), or gate networking (`--network none` unless codeDoesRemoteIo) and keep the claim.
- Verify: README.md:27 vs `grep -n "network" src/lib/sandbox/docker-*.ts`.

**DOC-2 · P2 · CHANGELOG is dead — one entry, ~1.5 years stale**

- Evidence: single `## [0.1.0] - 2025-01-01` entry; 131 commits since 2026-06-19 alone unrecorded; release-notes/ holds 6 posts doing the job informally.
- Recommendation: Maintain per release (seed from release-notes) or delete and point at release-notes/ — a false-fresh changelog is worse than none.
- Verify: `head -12 CHANGELOG.md` vs `git log --oneline --since=2026-06-01 | wc -l`.

**DOC-3 · P2 · .env.example documents a BigQuery env preset the code cannot load**

- Evidence: .env.example Option B (WAREHOUSE*TYPE=bigquery / WAREHOUSE_BQ*\*); persist-env.ts:114-144 loadLegacyFromEnv switches only on postgresql/clickhouse; `grep -rn WAREHOUSE_BQ src` → 0.
- Recommendation: Implement the bigquery case or delete Option B.
- Verify: `grep -rn "WAREHOUSE_BQ" src` → empty; persist-env.ts:119-143 case list.

**DOC-4 · P3 · .env.example missing env vars the code reads**

- Evidence: LOG_LEVEL (logger), AWS_PROFILE, E2E_BASE_URL, HF_HOME read in code but absent from .env.example.
- Recommendation: Add LOG_LEVEL + AWS_PROFILE (commented); document E2E_BASE_URL at the top of the e2e script.
- Verify: Diff `grep -rhoE 'process\.env\.[A-Z_0-9]+' src scripts | sort -u` against .env.example keys.

**DOC-5 · P3 · CONTRIBUTING.md prescribes npm; the project standard is pnpm 10**

- Evidence: CONTRIBUTING "Making Changes" step 3 uses npm; README/CI/lockfile standardize pnpm; a stray package-lock.json sits at repo root.
- Recommendation: Switch CONTRIBUTING to pnpm, note required major (10), delete the stray package-lock.json if unused.
- Verify: `grep -n "npm " CONTRIBUTING.md`; `ls package-lock.json pnpm-lock.yaml`.

**DOC-6 · P3 · Doc artifacts scattered across 8 top-level dirs; no ADRs; no repo CLAUDE.md**

- Evidence: spec/ (11 files) AND specs/ (2 newer) both exist; comparisons/ holds 3-4 dated snapshots of the same doc; audits/, release-notes/, test-specs/, design/ are siblings; docs/ is images-only. No adr/ convention; no CLAUDE.md despite heavy agent-assisted development.
- Recommendation: Consolidate under docs/ (docs/specs, docs/adr, docs/audits, docs/img); merge spec/+specs/; keep latest comparison per competitor; add a repo CLAUDE.md with build/test/layout conventions.
- Verify: `ls spec specs comparisons | sort`; `ls CLAUDE.md` → currently absent.

---

## 5. Cross-cutting observations & reasoning

1. **The extraction pattern works — finish it.** Every place the team extracted a shared module (runWarehouseQuery, composeAndStreamDashboard, duckdb-source, createSpecFinalizer), drift stopped. Every place they didn't (streaming scaffold, materialization, epilogue, disconnect-persistence, provider lists), drift resumed and has produced at least five _observable_ asymmetric bugs (ARCH-1, ARCH-2×2, ARCH-4, ARCH-6). WS1 is the highest-leverage work in this document.
2. **Comment discipline is genuinely excellent and is currently substituting for structure.** 400-line functions and 83 bare catches are all _explained_ — but explanation doesn't make them testable or safe to change. The refactors in WS5/WS7 should preserve the comments' _content_ as module-level docs.
3. **The prompt layer is production logic and is churning fast** (5 commits/week) with prose-pinned tests. TEST-9's structural-sentinel approach is the sustainable contract; without it, TEST-1 will recur on the next prompt tweak.
4. **Risk-inverted test coverage is the core testing problem, not the volume.** 1,128 fast deterministic tests is a strong base; they're just concentrated on pure logic while the I/O seams (LLM client, sandbox, routes, streaming) — where all recent production bugs occurred — are dark. WS6's order reflects "test where the bugs have actually been."
5. **Local-tool security posture is reasonable but undocumented.** The implicit threat model (loopback-only, single-user, browser-origin checks) is fine; nothing states it. One paragraph in the README plus the WS4 fixes would make the posture explicit and the hosted-upgrade path clear.
6. **Two data-corruption-class bugs deserve attention despite P3 severity labels:** CORE-12 (NaN regex corrupting strings in user-visible results) and API-4 (dialect-incorrect identifier escaping). Both are silent-wrong-output, the worst failure class for a data-analysis tool.

## 6. Strengths — do not regress

| Strength                                                                                          | Evidence                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean layer direction: zero lib→components/app imports                                            | `grep -rn "from '@/components\|from '@/app'" src/lib` → 0                                                                                                                          |
| Shared hardening modules used by both routes                                                      | runWarehouseQuery (route.ts:255 / investigate:310); composeAndStreamDashboard (route.ts:489 / investigate:504); run-query.ts:1-14 header: "Future warehouse-SQL fixes belong HERE" |
| Plugin seams: sandbox executor map, warehouse connector interface, self-documenting chart catalog | sandbox/index.ts:189-193; warehouse/connector.ts:26-80; catalog.prompt() feeding the composer (dashboard-compose.ts:497)                                                           |
| Per-widget render error boundary with named fallback                                              | registry.tsx:44-72 (wrapAll)                                                                                                                                                       |
| Exemplary code-splitting: all 60 charts dynamic, plotly/deck.gl/three lazy                        | registry.tsx:76-314; plotly-wrapper.tsx:8-11; page.tsx:37-40                                                                                                                       |
| AsyncLocalStorage-scoped cost accounting incl. streamed-usage attribution                         | cost/accumulator.ts:63-68; client.ts:936-1003                                                                                                                                      |
| Warm-sandbox op serialization (opChain) + HMR-versioned registry                                  | warm-sandbox.ts:47-62, :166                                                                                                                                                        |
| OOM heuristic with actionable retry guidance (Docker path)                                        | docker-utils.ts:80-90                                                                                                                                                              |
| Fast deterministic suite: 1,128 tests ~18s, zero snapshots, 1 fake-timer file, no network         | vitest run output; grep toMatchSnapshot → 0                                                                                                                                        |
| CI gates lint+format+tsc+build+coverage on Node 20/22                                             | .github/workflows/ci.yml:17-76                                                                                                                                                     |
| Coverage ratchet with rationale + separate lib gate                                               | vitest.config.ts:27-42                                                                                                                                                             |
| Documented global patches with unit test (ResizeObserver)                                         | patch-resize-observer.ts header; lib/**tests**/patch-resize-observer.test.ts                                                                                                       |
| Reject-by-default SQL-literal sanitizers for remote URLs/creds                                    | duckdb-source.ts:47-61                                                                                                                                                             |
| UUID-validated history IDs closing fs traversal                                                   | history/storage.ts:245-249                                                                                                                                                         |
| Middleware rate-limit + DNS-rebinding origin check + security headers                             | middleware.ts:35-74                                                                                                                                                                |
| Loopback-only default binding                                                                     | start.sh:1109,1155                                                                                                                                                                 |

---

## 7. Suggested fix sequence (condensed checklist)

```
[ ] 0a  TEST-1   fix 2 red prompt assertions (unblocks CI on PR #93)
[ ] 0b  DOC-1    correct README isolation claim (or add --network none gating)
[ ] 1   WS1      extract patch-stream / materialize / epilogue / disconnect-persist / validate  (ARCH-1..4, ARCH-10, API-10)
[ ] 2   WS2      zod boundaries + shared parseSandboxOutput + NaN-regex fix    (CORE-2, CORE-5, CORE-12, API-7)
[ ] 3   WS3      runId + dev timestamps + cost coverage + durations + serializeError + atomic cost append (OBS-1,2,3,5,6,13)
[ ] 4   WS4      local-files root-jail, SSRF host check, SELECT-only, sample-table validation, json 400s (API-1..5)
[ ] 5   WS5      page.tsx + investigate-closure decomposition; dead hook removal; runPipeline opts (ARCH-5/9, FE-1/2, CORE-4)
[ ] 6   WS6      orchestrator tests → sandbox arg tests → NDJSON protocol test → client.ts tests → pre-push hook → sentinel prompts (TEST-10,3,5,2,8,9,6,12)
[ ] 7   WS7+P3s  transport dedup, connector csv dedup, sweepers, memoization, empty states, a11y, docs cleanup
```

_End of review. Generated by six-dimension automated review at commit `34d548f`; all evidence verified read-only against the working tree on 2026-07-07._
