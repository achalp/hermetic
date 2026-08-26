# Modularization Phase 1 — Implementation Plan

**Date:** 2026-08-01
**Status:** Proposed
**Companion to:** `specs/modularization-2026-08-01.md` (the audit + phased plan; workstream WS1–WS8 references below point there)

This plan answers three questions: the concrete order of work, **how we guarantee no functionality breaks**, and **how the path to Phase 2 stays provably green** while Phase 1 lands.

---

## 1. The safety architecture (M0 — built before any refactoring)

Phase 1 touches the streaming pipeline, the spec format, the state layer, and the app shell. None of the existing test infrastructure can catch a regression in most of that surface today (3 test files for 71 charts; no end-to-end transcript tests; LLM calls are live). So the first milestone builds the net. **No refactoring PR merges before M0 is complete.**

### 1.1 Record/replay LLM transport

The single biggest obstacle to regression testing is LLM nondeterminism. Fix it at the provider seam:

- A `ReplayTransport` implementing the same interface as the live providers: **record mode** captures every request/response pair (prompt hash → response) to `test-fixtures/llm/`, **replay mode** serves them back and fails loudly on a cache miss.
- Because `getModel()` is the single chokepoint every LLM call already flows through (audit §2.3), the transport hooks in at one place today, and becomes a constructor argument of `LLMClient` after WS3 — the fixture format outlives the refactor.
- Record fixtures for the core journeys (below) once, against real providers, and commit them. A prompt change invalidates its fixture visibly (hash miss), which is exactly the alarm we want: **prompt drift becomes a reviewable diff, not a silent quality change.**

### 1.2 Golden transcripts — the primary regression oracle

For each core journey, capture the **full NDJSON patch stream** from request to close, normalized (strip timestamps, run ids, durations; stable-sort where order is legitimately nondeterministic), and commit it. A CI job replays the journey with the ReplayTransport + deterministic sandbox fixtures and diffs the transcript byte-for-byte after normalization.

Core journeys (minimum set):

1. CSV upload → ask → dashboard spec (happy path)
2. Ask with a code-execution retry (sandbox failure → regenerate loop)
3. Warehouse question → SQL gen → materialize → dashboard (stub connector implementing `WarehouseConnector` — the interface already exists)
4. Investigate (multi-wave) → notebook spec, including `__plan`/`__cells`/`__grounding` emission
5. Edited-SQL rerun and edited-code rerun paths
6. Drill-down request (conversation-cache hit path)
7. Reattach to a running stream (`/api/query/attach`)
8. History save → load → refresh; saved-viz save → rerun

These transcripts are the contract the refactor must preserve. **Every "move, don't improve" PR must show transcript diffs are empty.** When a PR intentionally changes behavior (rare in Phase 1), the transcript diff is reviewed like a schema migration and the golden file is re-recorded in the same PR.

Why transcripts and not unit tests: the audit showed the risky invariants are protocol-level (wholesale-vs-incremental `__progress` patches, `__warehouse_csv_id` survival, state-clobbering bug class in `patch-stream.ts`). Transcripts pin all 13 `__` keys, their ordering, and the spec payload at once.

### 1.3 Renderer regression harness

- Extend the existing `test-spec` page assets: every spec fixture in `test-specs/` gets a **render smoke test** (JSDOM: mounts `<SpecView>` — initially the current provider stack — asserts no error boundary trip, no console.error, and a stable serialized element tree).
- Add one fixture per catalog component family that lacks one (the 84 zod schemas already have one valid sample each in `chart-catalog-schemas.test.ts` — reuse those samples as render inputs). This is how 69 untested chart components get baseline coverage cheaply.
- `catalog.prompt()` **snapshot test** — committed before WS2 begins, so the fork must reproduce it byte-identically.

### 1.4 CI ratchets — regressions can't creep back

A `scripts/ratchet.ts` CI step counts, per metric, the current number of violations and fails if any count **increases**; the committed baseline only ever goes down. Metrics (baseline ≈ audit numbers):

| Metric                                                     | Baseline → target                |
| ---------------------------------------------------------- | -------------------------------- |
| `process.env` reads in `src/lib`                           | ~60 → 0                          |
| `process.cwd()` in `src/lib`                               | ~14 → 0                          |
| `globalThis.__` stores                                     | 11 → 0                           |
| `import "server-only"`                                     | 36 → 0                           |
| Raw `fetch(` in app layer (non-`api.ts`)                   | 37 → 0                           |
| `as unknown as` at API boundary                            | 13 → 0                           |
| `@json-render` import lines                                | 49 → 0                           |
| Untyped `__` key reads (regex for `state.__`/`["__` casts) | ~40 → 0 (only `readStreamState`) |
| ESLint boundary-rule suppressions                          | n → 0                            |

The ratchet is both the no-regression guard **and** the progress dashboard: Phase 1 is done when every row reads 0, and it can never silently un-finish.

### 1.5 Working agreements

- **Move-don't-improve**: mechanical relocation and behavior change never share a PR. A "move" PR must show empty transcript diffs and unchanged snapshots; a "change" PR must name which golden files it re-records and why.
- **Trunk stays shippable**: no long-lived refactor branch. Every PR leaves `pnpm dev` fully working — the strangler pattern (new seam added, callers migrated, old path deleted) happens across small PRs, not in one.
- **Workaround comments become tests first**: the app layer's guard comments each document a bug (StrictMode double-fire, seq races, save/export no-op sync). Before deleting any workaround in WS7, its comment is converted to a regression test that fails on the old bug. The comments are the test plan.
- **No new features on refactored surfaces mid-flight** (feature work on untouched surfaces is fine; rebasing cost stays contained).

M0 estimate: **~1 week** (transcripts and replay transport dominate; ratchet script is a day).

---

## 2. PR-level sequencing

Numbered PRs are ordering constraints; letters within a number are parallel. Sizes are S (<½ day review), M (½–1 day), L (needs a dedicated reviewer pass).

### Milestone M0 — Safety net (~1 wk)

| PR  | Content                                                                                                                                            | Size |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 0a  | ReplayTransport + fixture recording for journeys 1–8                                                                                               | L    |
| 0b  | Golden-transcript CI job + normalizer                                                                                                              | M    |
| 0c  | Renderer smoke harness + catalog sample renders + `catalog.prompt()` snapshot                                                                      | M    |
| 0d  | Ratchet script + baselines + ESLint boundary rules in **warn** mode                                                                                | S    |
| 0e  | §2.7 bug fixes (archive list, colon-split, dashboardRef, debug log, dead tests flagged) — each trivially verifiable, lands before the churn starts | S    |

### Milestone M1 — Contracts (WS1, ~1 wk) — everything else depends on this

| PR  | Content                                                                                                                                                  | Size |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 1a  | `contracts/` package: split `types.ts` (spec-types / storage-types / connection-configs); zod-first where `api-schemas.ts` duplicates; delete `types.ts` | L    |
| 1b  | `StreamState` module: typed 13 keys, `readStreamState()`, `RESERVED_STATE_KEYS` + composer validation; delete triplicated client shapes                  | M    |
| 1c  | `AnalysisRequest` shared type + zod; both client body-builders and the server cast collapse onto it                                                      | M    |
| 1d  | Constants consolidation: ports, container prefix, in-container paths, sentinel host, localStorage keys, CDN URLs (config-overridable)                    | S    |
| 1e  | Type-only leak fixes (`CachedArtifacts` et al. → contracts); `RECENTS_CHANGED_EVENT` move; `client-pipeline.ts` → `data-transforms/`                     | S    |
| 1f  | Remove all `import "server-only"`; ESLint boundaries → **error** mode                                                                                    | S    |

Gate: transcripts unchanged; ratchet rows for `server-only`, untyped `__` reads, `as unknown as` hit 0.

### Milestone M2 — parallel tracks (after M1)

**Track A — Own the spec contract (WS2, 2–3 wk):**

| PR  | Content                                                                                                                                                                                                                 | Size |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| A1  | Vendor the fork under `src/spec/` (envelope, DSL, prompt gen, patch utils, React runtime) with upstream tests ported; **no consumer switched yet**. License attribution (Apache-2.0 NOTICE).                            | L    |
| A2  | Differential test rig: every existing fixture spec through upstream and fork — identical render trees; `applySpecPatch`/`setByPath` property-based differential tests; `catalog.prompt()` byte-identical vs 0c snapshot | M    |
| A3  | Switch consumers directory-by-directory (inputs → registry → app → lib/pipeline → routes), one PR each, transcripts + snapshots unchanged                                                                               | M×5  |
| A4  | Delete `@json-render/*` from package.json (+ dead `shadcn`); single `Spec` type; `validateSpec()` wired into tests and the compose path; `hermeticSpecVersion` written + compat shim + version test                     | M    |
| A5  | Delete `assemble-spec.ts` hand-mirror in favor of owned utils                                                                                                                                                           | S    |

**Track B — Config & environment (WS3, 3–4 d):**

| PR  | Content                                                                                                                                                          | Size |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| B1  | `HermeticConfig` type + boot-time resolution in the Next harness; `validateEnv()`/logger registration become explicit boot calls                                 | M    |
| B2  | `LLMClient`: single detection path, lazy provider imports, cost hook explicit, `cachedSystem`/`cachedText` as methods; ReplayTransport becomes a constructor arg | L    |
| B3  | Env inventory: `.env.example` complete; platform declaration; `server-timeouts.mjs` derives from shared constant                                                 | S    |

**Track C — Storage & state (WS4, 1.5 wk):**

| PR  | Content                                                                                                                                                                  | Size |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| C1  | `HermeticPaths` module; all path consts route through it (harness supplies roots); credentials move into data dir                                                        | M    |
| C2  | `StateStore` interface + in-process impl; migrate the 11 stores behind it one-per-PR where risky (warehouse connectors and warm-sandbox are the two with live resources) | M×3  |
| C3  | `RecordStore` unifying history/saved layouts; typed corrupt-record results                                                                                               | M    |
| C4  | TTL inversion (`isRunLive` injection); sweeper on the interface; in-place schema mutation fix                                                                            | S    |

### Milestone M3 — Orchestration (WS5, 1.5 wk; after B1/B2, benefits from C-track)

| PR  | Content                                                                                                                                                                                | Size |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 3a  | Mechanical lift: `runAskQuery` extracted verbatim from `/api/query/route.ts`; route becomes a shell. **Transcripts must be byte-identical** — this is the PR the golden set exists for | L    |
| 3b  | Same for `runInvestigateQuery` (951 LOC)                                                                                                                                               | L    |
| 3c  | `validate-request` returns typed results; `llm/`+`pipeline/` reorganize into `generation/`+`orchestration/` (cycle broken by 1a)                                                       | M    |
| 3d  | De-god the 20-field options bag onto the contract types; prompt building takes skills/runtime content as inputs (filesystem reads move to boot)                                        | M    |

### Milestone M4 — Sandbox rebuild (WS6, 1.5–2 wk; after M1, parallel with M3)

| PR  | Content                                                                                                                                                      | Size |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| 4a  | Extract Python prelude to `docker/sandbox/`; shared `__progress` JSONL schema (Python + TS import the same spec); journey-2 transcript guards the retry loop | M    |
| 4b  | Break the 8-module cycle; options-object signature; runtime files injected not cwd-read                                                                      | L    |
| 4c  | Inversion: `SandboxBackend` + `AbortSignal` + `onProgress`; zero `pipeline/` imports (ratchet row)                                                           | M    |
| 4d  | Container labels for reaping; warm pool behind `StateStore`; Dockerfile digest pin; `start.sh` cleanup                                                       | S    |

### Milestone M5 — Renderer & app (WS7, 2–2.5 wk; after M1 + Track A)

| PR  | Content                                                                                                                                                            | Size |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| 5a  | `<SpecView>` single entry (provider stack + error boundary); the 5 call sites migrate; `test-spec` page uses it                                                    | M    |
| 5b  | Drill-down via real context (delete both module refs); regression test: two mounted panels                                                                         | M    |
| 5c  | Theme detox (props-driven provider; harness owns persistence + generated no-FOUC script); deck.gl opt-in entry; `next/dynamic` → `React.lazy`                      | M    |
| 5d  | `useAnalysisStream` extraction (endpoint, `AnalysisRequest` body, seq latch, reattach) — each StrictMode/seq workaround becomes a test first                       | L    |
| 5e  | `AnalysisContext`: single owner of spec/artifacts/csvId; delete the six redundant holders + duplicate `useArtifacts`; save-vs-artifacts id bug closes structurally | L    |
| 5f  | Split `page.tsx` / `response-panel.tsx` / `notebook-view.tsx`; context replaces 23-prop drills                                                                     | L    |
| 5g  | All fetches through `api.ts` (typed responses; warehouse union survives the drawer); engine forms + zod derived from `EngineDescriptor.fields`                     | M    |
| 5h  | Delete ~3,196 lines of dead components + their tests; middleware CSP + origin-guard coverage + bounded rate map                                                    | S    |

### Milestone M6 — Harnesses & proof (WS8, 3–4 d; after B, M3)

| PR  | Content                                                                                                    | Size |
| --- | ---------------------------------------------------------------------------------------------------------- | ---- |
| 6a  | `src/cli/`: `hermetic ask` → NDJSON/spec.json/HTML via `runAskQuery` + ReplayTransport-friendly config     | M    |
| 6b  | CI: CLI end-to-end on journeys 1, 4 with replay fixtures, **no Next import** (verified by a bundler check) | S    |
| 6c  | Next harness reduced to shared boot + thin routes                                                          | S    |

### Milestone M7 — Exit audit (2–3 d)

- Re-run the four audit passes (same prompts, fresh agents) against the finished tree; every §2 finding must be closed or have a recorded disposition.
- Ratchet table all zeros; exit criteria 1–9 from the companion spec checked off in a PR that updates its Status to **Done**.

**Critical path:** M0 → M1 → (A ∥ B ∥ C) → M3 → M6, with M4 and M5 off-path but exit-gating. Wall-clock ~9–12 weeks solo; ~6–7 with two people (one on A+5, one on B+C+3+4).

---

## 3. How functionality is guaranteed not to break — summary of mechanisms

1. **Golden NDJSON transcripts** for 8 journeys, diffed on every PR — pins the full wire protocol, all 13 `__` keys, and final specs. Built before refactoring starts; intentional changes re-record goldens in-PR under review.
2. **Record/replay LLM fixtures** — deterministic CI, and prompt drift surfaces as a fixture-hash failure instead of silent output-quality change. `catalog.prompt()` additionally snapshot-tested (the fork must be byte-identical).
3. **Differential testing for the fork** (Track A2): upstream and vendored implementations run side-by-side on every fixture until the moment the dependency is deleted — equivalence is proven, not assumed.
4. **Renderer smoke renders** for every catalog component from existing zod samples — the 69 untested charts get a baseline before anything moves them.
5. **Workaround-comment → regression-test rule** — the documented StrictMode/seq/sync bugs can't be reintroduced by the state consolidation that removes their guards.
6. **Move-don't-improve PR discipline + shippable trunk** — behavior changes are always isolated, reviewable, and small; there is no big-bang merge.
7. **Ratchets** — none of the eliminated flaw classes (ambient reads, raw fetches, casts, globals) can quietly return, during Phase 1 or after.
8. **Live-resource care**: the two stores holding real resources (warehouse connection pools, warm sandbox containers) migrate in dedicated PRs (C2) with manual verification steps in the PR template (connect → query → disconnect; warm-start latency check).

## 4. How the path to Phase 2 stays green

Phase 2 is packaging what Phase 1 built — so the plan continuously proves the future package boundaries, not just current behavior:

1. **Isolation type-check in CI** (from M1 onward): a `tsc` project-references build (or per-directory `tsc --noEmit` script) compiles `contracts/`, `spec/`, `renderer`, `connectors`, `generation`, `orchestration` **each in isolation** with only their declared deps. The Phase 2 package split stays a `git mv` because CI proves, on every PR, that each library already compiles alone.
2. **The CLI is a permanent second consumer** (M6): any accidental Next/app dependency in a library breaks a build the same day, not at externalization time.
3. **Spec versioning live from A4**: `hermeticSpecVersion` written, compat shim exercised by a fixture-of-every-version test. Phase 2 inherits a working migration mechanism, not a plan for one.
4. **Public-shaped seams**: contract names/types (`LLMClient`, `SpecView`, `WarehouseConnector`, `StreamState`, `HermeticConfig`) are reviewed in M1/B/A PRs as API — a `contracts/README.md` documents each as if published, so Phase 2 docs start half-written.
5. **License hygiene from A1**: Apache-2.0 NOTICE/attribution for the vendored fork lands with the fork, not retro-fitted at publish time.
6. **Dependency fences**: the ratchet gains rows for "new prod dependency in renderer closure" and "new exact-pin without a recorded rationale" — the two dependency-hygiene failure modes the audit found, kept from recurring.
7. **Phase 2 readiness checklist** appended to the companion spec and updated at each milestone: envelope owned ✓, isolation builds ✓, version field ✓, second consumer ✓, licenses ✓, CSS decision (open — the one Phase 2 item with no Phase 1 precursor; schedule the decision, not the work, before M7 so externalization has no unknowns).

## 5. Rollback & contingency

- Every milestone is independently revertible: seams are additive until the "delete old path" PR, which is always its own PR (`git revert` restores the old path without touching the seam).
- If Track A (fork) stalls: A1–A2 are non-invasive (fork exists, consumers unswitched); the app keeps running on `@json-render@0.8.0` indefinitely while A3 proceeds at its own pace. The pin is the fallback, not the plan.
- If transcript normalization proves flaky for investigate (multi-wave nondeterminism): fall back to structural assertion (key set + patch-path sequence + final spec deep-equal) for journey 4 only; keep byte-level for the rest.
- Live-resource migrations (C2) ship behind a config flag for one release each (`HERMETIC_STATE_STORE=legacy|v2`) — the only feature flags in the plan, removed in the following PR.
