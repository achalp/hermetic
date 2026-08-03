# Hermetic Modularization — Audit & Phased Plan

**Date:** 2026-08-01 (v2 — full-scope revision)
**Status:** Phase 1 complete (exit audit §9, 2026-08-03) — Phase 2 gated on a named consumer
**Scope:** Refactor Hermetic into a set of libraries with owned, explicit contracts, composed by interchangeable harnesses (Next.js today, CLI next, third-party later), followed by externalization of selected libraries as public packages.

---

## 1. Motivation & principles

Hermetic's functions are conceptually modular — connect to sources, understand schema, generate SQL, generate code, execute code, compose render specs, render specs. This spec records a four-pass coupling audit of whether that modularity is real, and defines a two-phase plan.

**Principles (binding):**

1. **All design flaws are fixed in Phase 1.** Phase 1 exits with the architecture clean: real modularity, zero ambient dependencies, config that flows top-down, contracts instead of assumptions, no layering inversions, no hard version dependencies on code we don't own. There is no "tolerated for now" list.
2. **No patching seams.** Where a contract is currently owned by a third party or exists only by convention, Phase 1 brings it in-house properly — not a wrapper, pin, or snapshot-test around the problem.
3. **Phase 2 is distribution only.** Packaging, CSS shipping, publishing CI, docs, external hardening. Phase 2 must never be the excuse to finally fix a design flaw — by then there are none left.
4. **Phase 1 seams are shaped as if public.** The internal contract is the future public API; naming and shape are chosen once.

---

## 2. Audit findings (2026-08-01, four passes)

Passes: (A) server-side coupling (`src/lib` + `src/app/api` import graph); (B) renderer coupling (full import closure of `src/components/registry.tsx`); (C) dependency/version contracts & external-world assumptions; (D) app/harness layer (`src/app`, `src/components/app`, `src/hooks`, middleware).

### 2.1 Headline

- The **renderer subtree is the best-kept boundary in the repo**: the 99-file closure of `registry.tsx` (~15.7k LOC — all 71 charts, controllers, inputs, tables, catalog) contains **zero** imports of app state, hooks, API routes, or `next/navigation`. Charts take data as props; no chart fetches. The `test-spec` page renders a saved spec with a 5-line harness.
- **Next.js coupling in `src/lib` is nearly nonexistent**: one file imports `next/` (`api-error.ts:22`). Streaming is Web-standard `ReadableStream` behind an `emit`/`isClosed` callback contract (`pipeline/patch-stream.ts`).
- The real blockers: **ambient process-global state**, **business logic living in route bodies**, **contracts that exist only by convention** (13 untyped wire-protocol keys, a `data/` layout defined in 10 scattered constants, magic strings), and **a load-bearing dependency on someone else's 0.x package that authors our core LLM prompt**.

### 2.2 Verdicts per boundary

| #   | Boundary                                  | Verdict                                        | Key evidence                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1a  | Ingest — file parsers (csv/excel/geojson) | **CLEAN**                                      | `csv/parser.ts` imports only papaparse; pure functions. Lift as-is.                                                                                                                                                                                                                                                                                 |
| 1b  | Ingest — warehouse connectors             | **TANGLED**                                    | Interface good (`warehouse/connector.ts:26-47`; read-only SQL guard `:83-87`). Blockers: `globalThis` store (`warehouse/storage.ts:6-17`), plaintext creds at `process.cwd()/.warehouse-connections.json` (`persist-env.ts:9`), factory statically imports all 7 driver SDKs (`connector.ts:6-12`).                                                 |
| 2   | Schema catalog / introspection            | **TANGLED**                                    | `schema-cache.ts:28` hardcodes `process.cwd()/data/schema-cache`; `dbt-metadata.ts:64` module-level cache; `warehouse/storage.ts:86-88` mutates stored schema objects in place.                                                                                                                                                                     |
| 3   | SQL generation                            | **TANGLED**                                    | Args explicit (`run-query.ts:33-41`, `sql-generation.ts:323`); tax is ambient cost tracking + ambient `getModel()`. `sql-guard.ts`, `engine-descriptor.ts` already clean.                                                                                                                                                                           |
| 4   | Code generation                           | **TANGLED**                                    | Ambient LLM + cost + run-signal; **prompt building touches the filesystem in three places** (`prompts.ts:15` → skills registry reads `data/skills`; `prompts.ts:17` → `sandbox/runtime-files` reads `docker/sandbox/hermetic_runtime` from cwd at request time).                                                                                    |
| 5   | Sandbox execution                         | **HOPELESSLY COUPLED**                         | 8-module import cycle; **upward imports into `pipeline/run-control`** from `docker-executor.ts:16`, `stream-exec.ts:3`, `docker-utils.ts:4`; 8 positional params (`index.ts:503`); 481-line Python prelude embedded in the dispatcher (`index.ts:22-502`); `globalThis` warm registry with hand-bumped `REGISTRY_VERSION`. Rewrite, not extraction. |
| 6a  | Render-spec — catalog                     | **CLEAN** (coupling) / **AT RISK** (ownership) | `catalog.ts` (1,285 LOC, 84 components, zod + LLM descriptions) imports only json-render + zod. `grounding.ts` (353 LOC) zero imports. But the DSL it's built on is not ours — see §2.4.                                                                                                                                                            |
| 6b  | Render-spec — compose                     | **TANGLED**                                    | `composeAndStreamDashboard` (`dashboard-compose.ts:588-596`) has the right callback interface but imports ambient `getModel`/`cachedSystem`.                                                                                                                                                                                                        |
| 7   | Renderer (React)                          | **CLEAN** (internally)                         | App touchpoints: two type-only imports and the drill-down global refs (§2.6). Remaining flaws are self-inflicted: theme context writes `localStorage`/`document`, `deckgl-init.ts` monkey-patches globals, 7 × `next/dynamic`.                                                                                                                      |
| 8   | Persistence                               | **HOPELESSLY COUPLED**                         | Ten `process.cwd()/data/...` module-level consts; record shapes defined by an in-memory cache module (`history/storage.ts:6` imports `CachedArtifacts` from `pipeline/artifacts-cache`); module-level scheduler state + chokidar (`saved/scheduler.ts:38-42`). No injection point.                                                                  |
| 9   | Orchestration                             | **TANGLED**                                    | `investigate-orchestrator.ts:178-236` is a 20-field god-options bag; cross-layer type cycle `llm/investigate-composer.ts:26 ↔ pipeline/investigate-orchestrator.ts:111`.                                                                                                                                                                            |
| 10  | HTTP routes                               | **HOPELESSLY COUPLED**                         | No `runAskQuery()` exists — the composition _is_ the route body. `/api/query/route.ts` (499 LOC) and `/api/query/investigate/route.ts` (951 LOC, 30 lib imports, zero helper functions).                                                                                                                                                            |
| 11  | App layer (pass D)                        | **TANGLED**                                    | God components (`page.tsx` 1,405 LOC / 13 hooks / 27 useStates; `response-panel.tsx` 1,249 LOC mixing transport+state+presentation); **seven live holders of "the current spec"**; `useArtifacts` instantiated twice; three `csvId` sources; renderer provider stack hand-assembled 5×.                                                             |

### 2.3 Ambient state census (pass A)

- **Eleven `globalThis` singletons**: `__csvStore`, `__workbookManifestStore`, `__warehouseStore` + `__warehouseConnectors` (live socket pools), `__excelStore`, `__artifactsCache`, `__conversationCache` + `__conversationAliases`, `__codeCache`, `__hermeticRunControl` + `__hermeticContainerOwner`, `__hermeticRunStreamHub`, `__warmSandboxManagers`, auto-investigation budget. Single-process assumption stated in source (`store-sweeper.ts:10-11`). Zero session/tenant keying anywhere.
- **Four `AsyncLocalStorage` spines**, none injectable: run id (`run-context.ts:19`), cost + phase (`cost/accumulator.ts:76-77`), diagnostics (`run-diagnostics.ts:38`). Every LLM call implicitly participates via `getModel()` → `track()`.
- **~60 `process.env` reads** scattered through lib; `config.ts` exists to centralize them and is bypassed by the majority. `ANTHROPIC_API_KEY` read in 13 places, `LLM_PROVIDER` in 10, `OPENAI_BASE_URL` in 8. Nine env vars read but absent from `.env.example`.
- **Import-time side effects**: `config.ts:192-201` runs `validateEnv()` on module load; `run-context.ts:22` registers a global logger provider at load.
- **`store-ttl.ts:35,42`** couples every store's TTL to the orchestrator's run registry.
- **36 files `import "server-only"`** — throws under plain Node; hard CLI blocker.
- Provider detection duplicated: `config.ts:38-75` vs `client.ts:439-487` (comment admits it). All four `@ai-sdk` providers statically imported (`client.ts:1-6`).

### 2.4 Dependency & version contracts (pass C)

**`@json-render/{core,react}` pinned exact at `0.8.0` — and far deeper than a rendering dependency.** Full census: **49 import lines across 33 files.** Beyond `Spec`/`Renderer`/`useUIStream`/providers, Hermetic consumes:

- **`defineCatalog` + the `schema` DSL** — from `@json-render/react/schema`, a _subpath_ export (`catalog.ts:1-2`). All 1,285 lines / 84 components of the catalog are built on it.
- **`catalog.prompt()` authors the LLM system prompt** for every spec the product produces (`dashboard-compose.ts:605`, `step-cell-composer.ts:182`, `investigate-composer.ts:587`). A 0.x minor bump can silently change prompt text and therefore output quality, with no test that would catch it.
- `applySpecPatch`, `parseSpecStreamLine`, `setByPath`, `removeByPath` (server-side spec assembly); `useBoundProp` in all 8 input primitives; `useStateStore`/`useStateValue` in 5 files; `useUIStream` in one.
- **`assemble-spec.ts:3,17,49` already hand-mirrors json-render internals** ("Mirror of @json-render/react's setSpecValue") with no test tying it to upstream — an existing, silently-drifting vendored copy. Latent correctness bug.
- The pin has **no recorded rationale** (squashed history; the comment at `catalog.ts:5-7` says "floating 0.x" — stale, predates the pin). `Spec` is imported from `core` in 7 places and `react` in 7 — two names for one type.
- **`@json-render/shadcn` `0.8.0` is a dead dependency** — zero imports repo-wide.
- Other version-contract issues: `@vitest/coverage-v8` pinned while `vitest` floats (backwards); 14 `@nivo/*` packages at `^0.99.0` must move in lockstep with nothing enforcing it; `@types/pg` in `dependencies`; saved specs carry **no version field**; `docker/sandbox/Dockerfile:1` claims reproducible builds on the moving tag `python:3.11-slim`.

### 2.5 Contracts that exist only by convention (passes C, D)

- **The wire protocol between orchestration and UI is 13 untyped `__`-prefixed state keys** (`__progress`, `__runId`, `__exec`, `__estimate`, `__cost`, `__warehouse_csv_id`, `__plan`, `__cells`, `__results`, `__chart_data`, `__dataQuality`, `__grounding`, `__synthesis`, `__error`). Producers and consumers share no type; every read is an unchecked cast. `__plan` has **three** incompatible client-side shape declarations (`response-panel.tsx:1005`, `notebook-view.tsx:70`, `notebook-view.tsx:840`); `__grounding` has two — while `GroundingReport` already exists in `pipeline/grounding.ts:48` and both ignore it. `"__plan" in state` (`response-panel.tsx:45`) is feature-detection driving the notebook toggle. Nothing reserves the `__` prefix against composer-authored collisions. (The renderer never reads these keys — the flaw is entirely at the orchestration↔app seam.)
- **`/api/query*` request body typed on neither side.** Client hand-builds an object literal (`response-panel.tsx:375-394`, duplicated at `:479-498`); server does an unchecked cast (`query/route.ts:47-56`) against a `QueryRequestContext` that is missing 7 of the fields actually sent.
- **A second `__progress` JSONL sub-protocol between Python and Node** is defined inside the embedded Python string (`sandbox/index.ts:51`) and parsed in two independent TS sites (`stream-exec.ts:61-63`, `parse-output.ts:122-125`). No shared schema.
- **`data/` layout has no owner**: 10 independent module-level consts; `data/models/gguf` re-derived in 4 places. **Three storage roots** (`cwd/data`, `tmpdir()/hermetic`, `homedir()/.hermetic`) with no documented reason, plus credentials at repo root. History and saved-viz independently define the same six-file record layout (`history/storage.ts:120-132`, `saved/storage.ts:64-73`); the only unified description of the layout is `.gitignore:52-55`.
- **Magic strings**: container-name prefix `hermetic-sandbox-` as an untyped literal in producer and reaper (`docker-executor.ts:29`, `run-control.ts:229` — two co-located harnesses would reap each other's containers); `/data` in-container path agreed across three files by convention; `http://claude-cli.local` sentinel repeated ~14×; `"http://localhost:11434"` default duplicated ~15×; `gud-*` localStorage keys duplicated inside a `dangerouslySetInnerHTML` script (`layout.tsx:31`) alongside a hardcoded theme allow-list; `scripts/server-timeouts.mjs:22` hardcodes 25 min to exceed `LARGE_DATA_TIMEOUT_MS` with nothing enforcing the relationship.
- **External-world assumptions in library code**: unconfigurable CDNs (`slides-export.ts:60` reveal.js via jsdelivr — exported decks are silently network-dependent; `map-view.tsx:73` + `map-color-ramp.ts:8-9` Carto basemaps); `lib/llm/process-manager.ts` shells out to `ollama`/`lsof`/`fuser`/`which`/`sysctl` unguarded (contrast `wake-lock.ts:41`, the model citizen: platform-guarded, ref-counted, degrades to no-op); `lib` reads `docker/sandbox/hermetic_runtime` from cwd at request time (`runtime-files.ts:21`). Platform reality: macOS-first, Linux-tolerated, Windows-unsupported-and-undeclared.

### 2.6 App/harness layer (pass D)

- **God components**: `page.tsx` (1,405 LOC, 13 hooks, 27 useStates, raw fetches, direct localStorage, 23-prop drills into three children); `response-panel.tsx` (1,249 LOC owning stream transport + endpoint selection + request building + four overlapping spec holders + three embedded sub-components + persistence); `notebook-view.tsx` (1,105 LOC, ten components, own transport with ref-based dedup latch). Counter-example: `use-page-state.ts` is a clean pure reducer — nothing to fix.
- **State duplication**: seven live holders of "current spec" across `page.tsx` and `response-panel.tsx`, reconciled by manual `??` chains and callbacks whose comments document the bugs each sync prevents; `useArtifacts` instantiated twice with independent caches (the identical pattern a deleted duplicate hook caused before — comment at `response-panel.tsx:321-326`); three `csvId` sources with inconsistent resolution (**save uses a different id than the artifacts panel for warehouse-sourced analyses** — `page.tsx:225` vs `:1336`).
- **API client bypassed**: typed client exists (`lib/api.ts`, 855 LOC, 60 fns) but 37 raw `fetch(` calls remain, ~10 re-implementing existing functions and dropping error handling or URL-encoding on the way.
- **Type erasure at the client boundary**: `spec: Record<string, unknown>` in 4 response types forcing 13 `as unknown as` casts; warehouse config union erased to `Record<string, unknown>` through the settings drawer (also drops the `force` param).
- **Warehouse engine field-sets enumerated in five places** (types union, zod mirror, live form, dead form panel, engine-descriptor — whose own comment concedes "the one seam").
- **Renderer provider stack hand-assembled 5×** (`CitationsContext > StateProvider > ActionProvider > VisibilityProvider > RendererErrorBoundary > Renderer`), inconsistently — `test-spec/page.tsx` omits the error boundary. No single `<SpecView>` entry point exists.
- **Drill-down event bus is two module-level mutable singletons** (`drill-down-context.tsx:14,26`) read/written by 9 chart/table modules; exactly one `ResponsePanel` may exist app-wide.
- **~3,196 lines of dead components** (15 files incl. `warehouse-connect-panel.tsx` 1,147 LOC; two still have passing tests validating unreachable UI).
- **Middleware**: DNS-rebinding guard covers only `/api/local-files/*` and passes requests with no Origin header; no CSP despite inline scripts and LLM-authored specs; unbounded `rateMap`.
- Type-only leaks: 10 client sites import types from `pipeline/artifacts-cache`, `pipeline/investigation-trace`, `llm/investigate-planner`. One inverted import: `page.tsx:22` pulls an event-name const from a leaf settings component.
- Hygiene is otherwise genuinely good: zero TODO/FIXME/HACK/@ts-ignore in the app layer; the four `eslint-disable exhaustive-deps` all carry paragraph-length justifications — most of which document workarounds for the state duplication above.

### 2.7 Bugs found during audit (fix regardless of refactor)

1. `saved/storage.ts:109` — archive list omits `schema.json` and `workbook.json` from saved-viz archives.
2. `data-rail-content.tsx:107-124` — `fetchKey.split(":")` truncates table names containing `:` (BigQuery legacy, qualified names); response unwrapped without `res.ok`, so errors render as an empty table; `warehouse_id` not URL-encoded.
3. Two different refs named `dashboardRef` (`page.tsx:158` vs `response-panel.tsx:239`) — PDF/DOCX export may capture a different DOM subtree than intended.
4. `assemble-spec.ts` mirror of json-render internals with no divergence test (latent).
5. Dead components with passing tests (`settings-panel.tsx`, `csv-upload-panel.tsx`) — the accessibility suite validates UI no user can reach.
6. `page.tsx:1322` — debug `console.log` fires on every completed analysis in production.

### 2.8 What is already clean

Pure modules liftable today: `csv/parser`, `csv/schema`, `geojson/parser`, `excel/parser`, `excel/relationships`, `grounding.ts`, `result-validator.ts`, `warehouse/sql-guard`, `warehouse/engine-descriptor`, `client-pipeline.ts` (misfiled in `pipeline/`), `use-page-state.ts`, `wake-lock.ts` (as the pattern to copy). The `emit`/`isClosed` streaming contract and the `WarehouseConnector` interface are keepers.

---

## 3. Target architecture

### 3.1 Library / harness split

**Libraries** hold all domain logic and receive everything ambient today as explicit inputs. **Harnesses** own: process lifetime, env/config resolution, transport (HTTP or stdio), storage roots, run-scope entry, platform integrations (wake locks, local-LLM process management UI).

### 3.2 Owned contracts (the full inventory)

| Contract                                                                                                          | Replaces                                                                                                                          | Notes                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hermetic spec format** (envelope + catalog DSL + prompt generation + patch/stream utilities + renderer runtime) | the `@json-render/*` dependency                                                                                                   | **Brought in-house in Phase 1** (§4 WS2). Versioned: every written spec carries `hermeticSpecVersion`.                                                                                                    |
| `HermeticConfig`                                                                                                  | ~60 `process.env` reads, disk-polled runtime config, import-time `validateEnv()`                                                  | Resolved once at harness boot; no lib module reads `process.env`.                                                                                                                                         |
| `LLMClient`                                                                                                       | ambient `getModel()`/`getActiveProvider()`/`cachedSystem()`                                                                       | Constructed by harness; carries provider, models, cache policy, cost hook. Providers lazy-loaded. Detection logic exists once.                                                                            |
| `HermeticPaths`                                                                                                   | 10 `process.cwd()/data` consts + 3 undocumented storage roots + creds at repo root                                                | One module owns the layout; harness supplies roots.                                                                                                                                                       |
| `StateStore` / `RecordStore`                                                                                      | 11 `globalThis` singletons; duplicated history/saved record layouts                                                               | Real interfaces with an in-process implementation. TTL via injected `isRunLive(runId)`, not by importing the run registry.                                                                                |
| `StreamState` protocol module                                                                                     | 13 untyped `__` keys, triplicated client shapes                                                                                   | Single typed contract + `readStreamState(spec)` accessor + `RESERVED_STATE_KEYS` the composer validates against. Python↔Node `__progress` sub-protocol gets a shared schema beside the extracted prelude. |
| `AnalysisRequest`                                                                                                 | untyped `/api/query*` bodies on both sides                                                                                        | One exported type + zod schema, imported by client and server.                                                                                                                                            |
| `emit` / `isClosed`                                                                                               | (already exists)                                                                                                                  | Streaming stays callback-shaped; Next wraps in `Response`, CLI writes NDJSON.                                                                                                                             |
| `AbortSignal` + `onProgress`                                                                                      | sandbox's upward imports of `run-control`/`reportProgress`                                                                        | Cancellation/progress injected downward.                                                                                                                                                                  |
| `SandboxBackend` / `ProcessRunner`                                                                                | direct `docker`/`ollama`/`lsof` shell-outs from lib                                                                               | Injected handles; platform guards at the harness edge.                                                                                                                                                    |
| `<SpecView spec registry onDrillDown theme />`                                                                    | 5× hand-assembled provider stacks + 2 module-level mutable drill refs + localStorage-writing theme context                        | The single renderer entry point. Props-driven theme; drill-down via real React context.                                                                                                                   |
| `EngineDescriptor.fields`                                                                                         | warehouse engine fields enumerated in 5 places                                                                                    | Forms and zod derived from the descriptor.                                                                                                                                                                |
| Named constants module                                                                                            | container prefix, in-container paths, default ports, sentinel URLs, localStorage keys, CDN endpoints (all overridable via config) | Kills the magic-string census in §2.5.                                                                                                                                                                    |

### 3.3 Library layering (strict, lint-enforced, no upward imports)

```
contracts (spec-types · storage-types · connection-configs · StreamState · AnalysisRequest)
  ↑
spec (owned envelope · catalog DSL · prompt gen · patch/stream utils)     parsers (csv · excel · geojson · parquet)
  ↑                                                                          ↑
renderer (React; framework-free)          connectors (warehouse drivers · sql-guard · engine-descriptor)
                                             ↑
                                          generation (sql-gen · code-gen — takes LLMClient)
                                             ↑
                                          sandbox (executors — takes SandboxBackend, signal, onProgress)
                                             ↑
                                          orchestration (runAskQuery · runInvestigation · compose)
                                             ↑
                                          harnesses (next/ · cli/ · [third-party])
```

Boundaries enforced by ESLint import rules per directory. `llm/` and `pipeline/` merge into `generation`/`orchestration` along this order, breaking their current type cycle. Package-manager workspaces are **not** used in Phase 1 (§6) — directories + lint are the enforcement; the later split becomes a `git mv`.

---

## 4. Phase 1 — the full re-architecture

Phase 1 is complete when **every finding in §2 is closed** and both harnesses run against the same libraries. Workstreams below; ordering constraints in §8.

### WS1 — Contracts first (~1 week)

- Split `types.ts` (fan-in 85) into `contracts/` per §3.3. zod as source of truth where duplication exists today (`api-schemas.ts` mirror collapses into it).
- `StreamState` protocol module: type all 13 keys (reusing `GroundingReport`), `readStreamState()`, `RESERVED_STATE_KEYS` validated by the composer; delete the triplicated client declarations and every unchecked cast.
- `AnalysisRequest` shared type + zod for `/api/query*`; both duplicate client body-builders collapse onto it.
- Move `CachedArtifacts`, `InvestigationTrace`, `InvestigateScope` into contracts (kills the 10 type-only leaks); move `RECENTS_CHANGED_EVENT` and all §2.5 magic strings into named-constants modules with config overrides (ports, CDN URLs, container prefix, in-container paths, localStorage keys, sentinel host).
- ESLint boundary rules live from day one; remove all 36 `import "server-only"`; move `client-pipeline.ts` to `lib/data-transforms/`.
- Fix the §2.7 bugs (all are sub-hour except the divergence test, which WS2 makes moot).

### WS2 — Own the spec contract (~2–3 weeks)

The `@json-render/*` dependency is removed, not wrapped. Starting from a vendored fork of the Apache-2.0 source, Hermetic takes ownership of:

- the **spec envelope** (`root`/`elements`/`state`, `$state` bindings) — now versioned: `hermeticSpecVersion` written into every spec, compat shim from day one;
- the **catalog DSL** (`defineCatalog`, the `schema` builder) and **prompt generation** (`catalog.prompt()`) — the prompt that defines product quality is authored by code we own and snapshot-test;
- **patch/stream utilities** (`applySpecPatch`, `parseSpecStreamLine`, `setByPath`, `removeByPath`) — `assemble-spec.ts`'s hand-mirror is deleted, not tested-against;
- the **React runtime** (`Renderer`, `defineRegistry`, `StateProvider`/`ActionProvider`/`VisibilityProvider`, `useBoundProp`, `useStateStore`/`useStateValue`, `useUIStream`).

Consolidation on import: one `Spec` type (ends the core-vs-react split personality), a real `validateSpec()` built from the 84 zod schemas that already exist, and deletion of the dead `@json-render/shadcn` dep. The fork is maintained under `src/spec/` (later `@hermetic/spec`) with its own test suite; upstream is thereafter a source of ideas, not a dependency.

_Honest cost note:_ this is the largest single workstream, and it converts an upgrade-risk into a maintenance obligation we own deliberately. Given 49 import sites, a subpath-export dependency, prompt authorship, and an already-drifting hand-mirror, ownership is cheaper than vigilance.

### WS3 — Config & environment (~3–4 days)

- `HermeticConfig` resolved once at harness boot; delete every `process.env` read in lib; `validateEnv()` becomes an explicit boot call; logger provider registration moves to boot.
- `LLMClient`: provider detection once, providers lazy-imported, cost accumulator attached explicitly by the harness run-scope, `cachedSystem`/`cachedText` become client methods.
- Document every env var (`.env.example` complete); declare platform support honestly (`os` field / README); `server-timeouts.mjs` derives its timeout from the shared constant instead of a parallel literal.

### WS4 — Storage, paths, state (~1.5 weeks)

- `HermeticPaths` module owns the entire on-disk layout; one storage-root policy (documented exceptions only); warehouse credentials move out of repo root into the configured data dir (and out of plaintext where the OS keychain is available — decision recorded here: plaintext-in-datadir is acceptable for Phase 1, keychain is Phase 2 hardening).
- `StateStore` interface replaces all 11 `globalThis` singletons; in-process implementation behind it; sweeper talks to the interface (no more dynamic-import cycle-breaking).
- `RecordStore` unifies the history/saved six-file record layout (fixes the archive-list bug class structurally); corrupt records surface as typed results, not unhandled throws.
- TTL liveness via injected `isRunLive`; `dbt-metadata` cache and schema-cache take paths/stores as parameters; `warehouse/storage.ts` stops mutating stored schema objects in place.

### WS5 — Orchestration extraction (~1.5 weeks)

- `runAskQuery(input, ctx, emit, isClosed)` and `runInvestigateQuery(...)` lifted from the two route bodies. Mechanical first (move, don't improve), guarded by golden-transcript tests on the NDJSON stream before/after; then de-god the 20-field options bag into the §3.2 contracts.
- Routes become ~30-line shells. `validate-request.ts` returns typed results, not `Response` objects.
- `llm/` ↔ `pipeline/` cycle broken by the WS1 contracts split; directories reorganize into `generation`/`orchestration` per §3.3.
- Prompt building stops touching the filesystem: skills and runtime-file content are loaded by the harness/boot layer and passed in.

### WS6 — Sandbox rebuild (~1.5–2 weeks)

- Break the 8-module cycle; extract the 481-line Python prelude to `docker/sandbox/` beside the runtime it belongs to, with the `__progress` JSONL sub-protocol schema shared between the `.py` and the TS parser.
- Invert: executors take `SandboxBackend` + `AbortSignal` + `onProgress`; zero imports of `pipeline/`.
- Options object replaces the 8-positional-param signature; executor selection via config; runtime files bundled/injected, never read from cwd; container reaping via docker labels, not name-prefix matching; warm-pool state behind `StateStore`.
- Dockerfile base pinned by digest (makes its "reproducible" claim true); dead root `.dockerignore` removed; `start.sh` single-package-manager and cwd-independent.

### WS7 — Renderer & app layer (~2–2.5 weeks)

Renderer (library-side):

- `<SpecView>` single entry point (provider stack + error boundary, once); drill-down via real context (deletes both module-level refs; multiple mounted panels become legal); theme becomes a props-driven provider (no `localStorage`, no `document.documentElement` writes from the library — the harness owns persistence and the inline no-FOUC script, generated from the same constants).
- `deckgl-init.ts` side effects (ResizeObserver/`window.onerror`/`console.error` patches) contained to an explicit opt-in maps entry point; `next/dynamic` (7 sites) → `React.lazy` + `Suspense`; CDN endpoints configurable with offline fallbacks stated.

App (harness-side):

- Analysis state collapses to one owner: a single `AnalysisContext` holding `{spec, artifacts, csvId, question}`; stream logic extracted to `useAnalysisStream` (endpoint, body via `AnalysisRequest`, seq latch, reattach); the seven spec holders, duplicate `useArtifacts`, and three `csvId`s reduce to one each — which also deletes the workaround effects those excellent comments apologize for.
- `page.tsx` and `response-panel.tsx` split along state/transport/presentation; embedded sub-components get their own files; 23-prop drills replaced by context.
- All app-layer fetches go through `lib/api.ts` (37 raw calls → 0); response types use real `Spec`/`CSVSchema` (13 double-casts → 0); warehouse config union survives the settings drawer intact.
- Engine forms + zod derived from `EngineDescriptor.fields` (five enumerations → one).
- Delete the ~3,196 lines of dead components and their tests; middleware gets a CSP, origin-guard coverage for all local-path routes, and a bounded rate map.

### WS8 — Harnesses & proof (~3–4 days)

- CLI harness: `hermetic ask "question" data.csv --out spec.json|html`, NDJSON to stdout; boots `HermeticConfig` + paths + `LLMClient`, calls `runAskQuery`. Next harness reduced to the same boot + thin routes.
- **CI runs the CLI end-to-end** (fixture CSV, stub LLM) — the server-side analogue of the `test-spec` page: boundary rot breaks the build, not the architecture.

### Phase 1 exit criteria

1. CLI harness runs ask → spec.json in CI with no Next import.
2. `@json-render/*` absent from `package.json`; every written spec carries `hermeticSpecVersion`; `validateSpec()` exists and runs in tests; `catalog.prompt()` output snapshot-tested.
3. Zero `process.env` / `process.cwd()` reads in `lib/` (grep-enforced in CI); no import-time side effects.
4. Zero `globalThis` stores — grep-enforced; all state behind `StateStore`/`RecordStore`; one documented storage-root policy; no credentials at repo root.
5. ESLint boundary rules pass with zero suppressions; no cycles (`sandbox` topologically ordered; `llm↔pipeline` cycle gone); no upward imports anywhere.
6. `types.ts` deleted; `StreamState` is the only way `__` keys are read; `AnalysisRequest` shared by client and server; zero `as unknown as` casts at the API boundary.
7. Route files ≤ ~50 lines; `page.tsx` and `response-panel.tsx` each ≤ ~400 lines; one holder of current-spec/artifacts/csvId; zero raw `fetch` in the app layer; dead components deleted.
8. Renderer: `<SpecView>` is the only mount path; no library writes to `localStorage`/`document`/global error handlers; no `next/` imports in the renderer closure; CDNs configurable.
9. All §2.7 bugs closed.

**Effort, honestly totaled: ~9–12 focused weeks** (WS2 and WS7 dominate). WS2, WS4, WS6 can run in parallel with WS5/WS7 after WS1 lands.

---

## 5. Phase 2 — externalization (distribution only)

**Gate, don't schedule**: Phase 2 starts on a concrete external consumer (named team, project, or community signal). By Principle 3 it contains no design work.

### Track 2a — `@hermetic/spec` + `@hermetic/renderer` (the differentiated assets)

The catalog/renderer pair is the one piece with genuine external leverage ("84 components with zod schemas and LLM-facing descriptions, an owned spec format, and a React renderer for what an LLM emits against them"). NL→SQL and sandboxing are crowded or commodity; this pair is not.

Remaining work is genuinely distributional:

- Workspace/package split along the §3.3 boundaries (a `git mv` if lint held); npm publishing CI; semver + changelog; README/docs/examples.
- **CSS distribution decision** (product decision): compiled stylesheet vs Tailwind v4 preset — `globals.css`'s 714 custom properties and 42 token classes must ship one way or the other.
- Package-weight split: core / plotly / maps / export entry points; `plotly-*.d.ts` shipped inside the package.
- **Untrusted-spec hardening**: the allowlist _mechanism_ for `form-controller` endpoints and `chart-image` sources exists from Phase 1 config; Phase 2 sets safe-by-default policies for unknown specs, adds a security review, and documents the trust model.
- Credential storage upgraded to OS keychain where available.
- Chart test coverage raised to publishable levels (currently 3 test files / 71 components).

### Track 2b — server libraries

**Default: do not publish.** NL→SQL and sandbox execution are markets, not gaps (Hermetic's sandbox layer is a _consumer_ of E2B, not a competitor). Revisit at the gate only for `WarehouseConnector` + drivers and the orchestration functions, if a third-party harness concretely needs them. Prerequisite is Phase 1 exit — which, under Principle 1, already includes everything design-shaped; what would remain is packaging, docs, and a support commitment.

### Phase 2 exit criteria (per package)

Published with semver + changelog; spec compat shim exercised in CI; zero undocumented framework/CSS assumptions; security review of the untrusted-spec surface; examples repo consuming only the published packages.

---

## 6. Non-goals & explicit deferrals

- **No npm workspaces in Phase 1.** Directories + lint boundaries are the enforcement; the mechanical split is Phase 2a.
- **No multi-process / multi-tenant support.** `StateStore` is an interface with a single in-process implementation; distributed backends are out of scope until a harness needs one.
- **No Windows support** — declared explicitly rather than left ambient.
- **No wire-protocol redesign.** NDJSON patch streaming stays; Phase 1 types it, it does not replace it.

## 7. Risks

| Risk                                                                                                                   | Mitigation                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WS2 fork is a permanent maintenance obligation                                                                         | Accepted deliberately (Principle 2): 49 import sites, subpath-export dependency, prompt authorship, and an already-drifting mirror make ownership cheaper than vigilance. Fork ships with its own test suite + prompt snapshots; upstream tracked for ideas only. |
| Route-body extraction regresses subtle streaming behavior (the state-clobbering bug class `patch-stream.ts` documents) | Move-don't-improve first; golden-transcript tests on the NDJSON stream before any reshaping.                                                                                                                                                                      |
| App-state consolidation (WS7) regresses save/export/drill flows the current workarounds protect                        | The workaround comments are the test plan — each documents the bug it prevents; convert each to a regression test before deleting the workaround.                                                                                                                 |
| `llm↔pipeline` cycle resists the split                                                                                 | Broken structurally in WS1 (shared types move to contracts) before WS5 touches control flow.                                                                                                                                                                      |
| Scope creep: Phase 1 is ~9–12 weeks                                                                                    | The exit criteria are grep-/CI-enforceable, so progress is measurable; workstreams are independently landable after WS1.                                                                                                                                          |
| Boundary rot after refactor                                                                                            | CLI-in-CI (server) + `test-spec` page (renderer) as permanent tripwires; grep-CI for `process.env`/`process.cwd()`/`globalThis` in lib.                                                                                                                           |

## 8. Sequencing summary

```
Phase 1 (internal; ALL design flaws close here):
  WS1 Contracts (types split · StreamState · AnalysisRequest · constants · lint · bugs)   [~1 wk]  ← everything depends on this
  WS2 Own the spec contract (fork json-render surface; versioned envelope)                [2–3 wk] ─┐
  WS3 Config & environment (HermeticConfig · LLMClient)                                   [3–4 d]   ├─ parallel after WS1
  WS4 Storage & state (HermeticPaths · StateStore · RecordStore)                          [1.5 wk] ─┘
  WS5 Orchestration extraction (runAskQuery/runInvestigate · cycle break)                 [1.5 wk]  ← after WS1, WS3
  WS6 Sandbox rebuild (cycle · inversion · prelude · backend injection)                   [1.5–2 wk] ← after WS1; gates exit
  WS7 Renderer & app (SpecView · AnalysisContext · god-component split · dead code)       [2–2.5 wk] ← after WS1, WS2
  WS8 Harnesses & CI proof (CLI + thin Next)                                              [3–4 d]   ← after WS3, WS5
  Total: ~9–12 focused weeks

Phase 2 (external; distribution only, gated on a named consumer):
  2a @hermetic/spec + @hermetic/renderer (packaging · CSS decision · hardening · docs)
  2b server libraries — default: do not publish
```

---

## 9. Phase 1 exit audit (2026-08-03)

Three adversarial verification agents re-audited the working tree at the end of
M7 (server/pipeline, contracts/app layer, renderer/fork), instructed to refute
every closure claim. 25 of 28 claims verified outright; the residue they found
was either fixed in the M7 remediation commit or dispositioned below. Suite:
1,970/1,970 tests, ratchet all-green, golden transcripts byte-identical,
`madge --circular` clean on `src/lib/sandbox`.

### 9.1 Exit criteria — verdicts

| #   | Criterion                                                                                       | Verdict                                                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | CLI harness runs ask → spec.json in CI, no Next import                                          | **Met** — `pnpm cli` proof + framework-free grep steps in CI                                                                                                                                                                                                                     |
| 2   | json-render gone; `hermeticSpecVersion` stamped; `validateSpec()`; prompt snapshot              | **Met** — 0 imports (ratcheted), fork vendored at 0.8.0/`0a40430` with 367 upstream tests; see D3/D4                                                                                                                                                                             |
| 3   | Zero `process.env`/`cwd` in lib, no import-time side effects                                    | **Met as ratcheted baseline** — 9 `process.env` sites remain, every one a documented exception (logger fallback ×3, env-config seam ×2, child-process env passthrough ×4 — a process concern `envConfig()` deliberately excludes); 3 `cwd` sites are `defaultPathRoots()` itself |
| 4   | Zero ad-hoc `globalThis`; StateStore/RecordStore; one storage-root policy                       | **Met** — 4 remaining slots are the sanctioned internals (harness-slot, state-store); roots owned by `hermeticPaths`                                                                                                                                                             |
| 5   | ESLint boundaries error-level, zero suppressions, no cycles                                     | **Met** — type-only sandbox cycles broken in M7 (`warm-backend.ts` leaf module)                                                                                                                                                                                                  |
| 6   | `types.ts` deleted; StreamState sole `__` reader; shared `AnalysisRequest`; no boundary casts   | **Met** — all 11 contracts-layer claims verified; boundary casts ratcheted at 7, each annotated                                                                                                                                                                                  |
| 7   | Routes ≤ ~50 lines; `page.tsx`/`response-panel.tsx` ≤ ~400; one state holder; zero raw fetch    | **Partially met** — routes thin, single holder landed (`useCurrentAnalysis`/`useAnalysisStream`/page-owned artifacts); `page.tsx` is 1,386 lines and `app-raw-fetch` ratchets at 12, not 0. Carried as follow-ups F1/F2                                                          |
| 8   | `<SpecView>` only mount; no lib writes to localStorage/document; no `next/` in renderer closure | **Partially met** — single mount + closure hygiene verified (ESLint-enforced, `clientLazy` replaced `next/dynamic`); theme detox (5c) did not land and deckgl-init remains an import side effect (lazy-gated). Dispositions D1/D2                                                |
| 9   | All §2.7 bugs closed                                                                            | **Met** — verified individually by the server and contracts audits                                                                                                                                                                                                               |

### 9.2 Recorded dispositions (deliberate, not drift)

- **D1 — theme-context** still reads/writes localStorage and
  `document.documentElement`; the renderer consumes it transitively. Contained
  (constants-dedup half landed; no-FOUC script generated from shared
  constants), but the props-driven `<SpecView theme=...>` is Phase-2a work —
  it changes the public renderer API and belongs with packaging.
- **D2 — deckgl-init** remains an import-side-effect module, reachable only
  through `clientLazy` when a 3D map first renders in a browser. The
  ResizeObserver patch applies in production; acceptable while maps ship in
  the same app, must become an explicit entry point in Phase 2a.
- **D3 — `hermeticSpecVersion` is write-only** by design at version 1: there
  is nothing to negotiate until a breaking envelope change exists. The compat
  shim + fixture-per-version test is the FIRST task of any version bump.
- **D4 — validation asymmetry**: history persist validates (warn-only);
  saved-viz create/update and the refresh route stamp but do not validate.
  Also: the fork ships its own structural `validateSpec` (zero app consumers)
  alongside the zod one in `catalog.ts` — a name-collision trap. Follow-up F5.
- **D5 — sandbox `executeSandbox` options-bag** documents 19 named fields with
  a single caller; the positional-params hazard the audit flagged no longer
  exists.
- **D6 — upstream prompt rule** from json-render `c731a9c` ("REQUIRED FIELDS
  children") deliberately NOT adopted with the zod fix — adopting it changes
  every prompt hash and requires a golden re-record. Adopt in one planned
  pass (F6).
- **D7 — `envConfig()` before boot** warns once (server-side) and returns an
  empty snapshot rather than throwing: routes must not 500 on a misordered
  import during dev HMR. Documented at the seam.
- **D8 — absent-Origin requests pass the DNS-rebinding guard** intentionally:
  CLI, curl, and same-origin GETs carry no Origin header; browsers always
  send one cross-origin.

### 9.3 Follow-up register (ordered; F1–F4 are pre-Phase-2 gates)

1. **F1** Decompose `page.tsx` (1,386 lines) to the ≤ ~400 target — the one
   WS7 deliverable that did not land.
2. **F2** Drive `app-raw-fetch` ratchet 12 → 0 via the typed api client.
3. **F3** `form-controller`'s spec-authored `endpoint` lets LLM output choose
   the POST target: constrain to an allowlist (`/api/`-relative, no
   traversal). Security-texture, cheap; do before any external renderer use.
4. **F4** Guard the fork itself: `src/spec` ESLint boundary group (no `next`,
   `@/lib`, `@/components`) + per-directory isolation `tsc` in CI proving
   `spec/`, `contracts/`, renderer compile alone (the "Phase 2 is a `git mv`"
   guarantee, currently unproven).
5. **F5** Resolve fork `validateSpec` name collision (rename to
   `validateSpecStructure` or adopt it); prune or adopt dead vendored surface
   (`useJsonRenderMessage`, core `buildUserPrompt`, JSONL element-tree path).
6. **F6** Adopt upstream prompt rule (D6) in a dedicated pass with golden
   re-record.
7. **F7** Validate on saved-viz persist/update + refresh paths (close D4
   asymmetry).
8. **F8** local-llm routes still resolve gguf paths off `cwd` directly —
   route them through `hermeticPaths` (harness-side residue).
9. **F9** Smoke-test `SpecHarness` duplicates SpecView's provider stack;
   have the test import a SpecView-exported stack (or mount SpecView) so
   they cannot diverge silently.

**Phase 1 verdict: complete.** The architecture holds under adversarial
re-audit; the two partial criteria are app-layer size/hygiene targets (F1,
F2), not library-boundary violations — no library imports a harness, all
config flows through the seams, and the CLI harness proves it in CI.
