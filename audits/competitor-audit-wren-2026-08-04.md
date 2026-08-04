# Competitor engineering audit: WrenAI vs. hermetic

**Date:** 2026-08-04
**Method:** Shallow clones of `Canner/WrenAI` at HEAD `74bf59e` (2026-07-31) and branch
`legacy/v1` at `e42b8d0`; two adversarial code-survey agents plus direct file reads.
All claims below cite real files in those checkouts. Hermetic side reflects the
Phase 1 exit state (`specs/modularization-2026-08-01.md` §9, branch
`modularization-phase-1`).

---

## 0. Framing: there are two Wrens

Current WrenAI HEAD **deleted its GenBI application** — `wren-ui/`, `wren-ai-service/`,
`wren-launcher/`, `docker/`, `deployment/` moved to branch `legacy/v1` (tag `v1-final`).
HEAD is now the "Open Context Engine": a Rust/DataFusion semantic-SQL engine
(`core/wren-core`), Python SDK/CLI (`core/wren`), and an MCP tool server —
**zero LLM calls anywhere in it**. The like-for-like product comparison is therefore
against **v1**; HEAD serves as a reference for their post-reset engineering bar.

Scale (for fairness): Wren v1 = 15.4k LOC Python AI service + 61k LOC Next.js UI
(24.8k of it a GraphQL BFF: 22 repositories, 44 Knex migrations, 3 adaptors),
covering semantic modeling and 22 data sources. Hermetic is roughly half the surface
with a deliberately local, single-user scope. Some Wren weight is essential
complexity.

## 1. LLM-output contracts

**Wren v1** emits **vega-lite** (an external contract):

- Constrained decoding: `response_format: {"type": "json_schema"}` built from a
  Pydantic discriminated union of 7 chart schemas with `Literal`-pinned marks
  (`wren-ai-service/src/pipelines/generation/chart_generation.py:111-119`,
  `utils/chart.py:349-480`). **Hermetic does not do constrained decoding — worth adopting.**
- Validation against a vendored **2.23 MB** vega-lite v5 JSON schema
  (`utils/vega-lite-schema-v5.json`), applied with `jsonschema.validate`.
- **Failure mode is silent degradation**: both `ValidationError` and generic
  `Exception` return the same empty chart (`utils/chart.py:327-337`). No retry, no
  repair, no user-visible signal.
- The UI then patches specs with two near-duplicate corrector classes —
  `wren-ui/src/components/chart/handler.ts` (522 lines, untested) and
  `src/utils/vegaSpecUtils.ts` (308 lines, tested), constants copy-pasted and
  comment-flagged "identical to handler.ts".

**Hermetic** owns the spec contract: vendored runtime (`src/spec`, 367 upstream
tests), versioned envelope (`hermeticSpecVersion`), zod validation at every persist
path (warn-only but logged), narrative grounding audit, byte-identical golden
transcripts. Both projects vendored something — Wren vendored the _schema_, hermetic
vendored the _runtime_. Owning the runtime is what enables golden testing and
packaging; Wren cannot snapshot what vega-embed will render.

## 2. Cross-service contracts — Wren's weakest point

The wren-ui ↔ wren-ai-service boundary is hand-written: a 937-line axios adaptor
(`wrenAIAdaptor.ts`) with hand-mirrored types (`models/adaptor.ts:84-93` manually
re-declares Python `Literal`s from `services/ask.py:65-74`) and hand-rolled
snake_case→camelCase transformers. FastAPI generates OpenAPI; the UI never consumes
it. GraphQL codegen exists but only for browser↔BFF.

**Smoking gun:** `wrenAIAdaptor.ts:303-334` implements `generateAskDetail()` →
`POST /v1/ask-details` and its result getter — **no such router exists** in the AI
service (13 registered routers, zero grep hits), and both methods are live-called
from `askingService.ts:325` and `:794`. A hand-maintained boundary drifted to a
nonexistent endpoint and nothing caught it.

This is the failure class hermetic's `contracts/` layer + typed api client +
`scripts/isolation-check.mjs` exist to prevent (the isolation check caught 7 real
breaches on its first run).

## 3. Testing & determinism

**Wren v1:**

- The pytest suite **requires a live OpenAI key** — `tests/data/config.test.yaml`
  points at real `gpt-4.1-nano` + `text-embedding-3-large`, a live Qdrant, and a live
  wren-ui engine; CI injects `secrets.OPENAI_API_KEY`
  (`.github/workflows/ai-service-test.yaml:56-57`).
- Quality CI is **label-gated**: `ui-test`, `ui-lint`, `ai-service-test` all require
  a `ci/ui` / `ci/ai-service` PR label. An unlabeled PR runs no tests and no lint.
  No Python lint job in CI at all (ruff is pre-commit only).
- An entire pipeline test file is skipped (`test_ask.py`, all 4 tests,
  "Temporarily disabled"). A literal no-op assertion survives:
  `assert response.json()["status"] == "finished" or "failed"`
  (`test_usecases.py:83-88` — always truthy, with a TODO admitting it).
- **But**: a 5,509-LOC offline **answer-quality eval framework** (`eval/`) that
  hermetic has no equivalent of — Spider 1.0 / BIRD benchmark preparation, deepeval
  metrics, execution-accuracy that runs both SQLs and diffs DataFrames
  (`eval/metrics/accuracy.py:85`), optional LLM-as-judge, a DSPy prompt optimizer,
  and a Streamlit curation app. Not in CI, but real and substantial.

**Hermetic:** 1,976 tests fully offline; golden transcripts replay byte-identical
with no key (now provider-portable); CI unconditional on every PR; ratchet +
isolation gates fail closed. Hermetic's goldens prove _determinism_, not answer
_quality_ — Wren's eval framework is the single best thing to steal.

## 4. Type safety

Wren v1: `wren-ui/tsconfig.json` `"strict": false` + `skipLibCheck`; ESLint disables
`no-explicit-any`, `no-non-null-assertion`, `react-hooks/exhaustive-deps`;
**401 `: any`** annotations, 71 `catch (err: any)`. Python: no mypy/pyright anywhere;
ruff `target-version = "py38"` while requiring py312. Wren HEAD: still no Python type
checker across 21k LOC (annotations present, unverified).

Hermetic: strict TS, boundary lint at error severity, ratchet counts as regressions.
Not close.

## 5. Security posture

Different threat models: Wren v1 is a deployed multi-service web app; hermetic is
local-first.

Wren's good choices: no code execution at all (grep for exec/subprocess/eval in the
AI service: zero); SQL executed only remotely through an `Engine` ABC, dry-run-first
by default with a bounded 3-retry repair loop and engine-imposed row limits
(`utils/sql.py:71-163`); datasource credentials encrypted at rest; CVE-driven
dependency pins.

Wren's misses: "SELECT-only" is **prompt-level only** (`utils/sql.py:166-168`) — no
AST/statement gate anywhere, `sqlparse` installed but unused for it; `;`-stripping is
the only injection barrier. The GraphQL endpoint and the public REST API
(`run_sql.ts` executes arbitrary caller SQL) have **no authentication and no
middleware**; the AI service runs CORS `allow_origins=["*"]` with
`allow_credentials=True`.

Hermetic executes generated Python — a bigger capability with a bigger attack
surface — but the controls are code-level: Docker sandbox with injected hooks,
CSP derived from constants, DNS-rebinding origin guard, LLM-authored form endpoints
constrained to same-origin `/api/` (F3).

## 6. Where Wren is genuinely ahead

- **Answer-quality evals** (§3) — decisively.
- **Constrained decoding** for LLM output.
- **Provider seam**: `@provider` decorator registry with LLM/Embedder/DocumentStore/
  Engine ABCs (`src/core/provider.py:43-77`, `providers/loader.py:42-66`) — a real
  plug-point hermetic's `getActiveProvider()` switch only approximates.
- **Config class**: pydantic `BaseSettings`, ~28 typed fields, documented 4-tier
  precedence (`src/config.py`) — though 20 import-time `os.getenv` defaults leak
  around it in provider constructors.
- **Error taxonomy** (HEAD): 31 numerically-banded `ErrorCode`s + 12 `ErrorPhase`s,
  `WrenError` with cause chaining, zero bare excepts
  (`core/wren/src/wren/model/error.py`).
- **Versioned-contract migration machinery** (HEAD):
  `MAX_SUPPORTED_LAYOUT_VERSION = 4` with sequential migrations, each no-op's
  reasoning recorded (`wren-core-base/src/mdl/migration.rs`) — the mature version of
  hermetic's write-only `hermeticSpecVersion` (disposition D3).
- **Rust-core discipline** (HEAD): clippy `-D warnings`, insta snapshots, full TPCH
  sqllogictest suite, feature-flag-enforced pyo3 boundary, per-module release-please
  automation, 21 path-filtered workflows, a written contribution bar, 17 TODOs total.
- **Observability**: Langfuse tracing throughout; locust load tests.

## 7. Where hermetic is ahead

- Offline determinism and unconditional CI gates (§3).
- Enforced boundaries: ESLint error groups, ratchet, isolation module-graph check —
  vs. Wren v1's conventional layering and drifted hand-written adaptor (§2).
- End-to-end type safety (§4).
- Owned render contract vs. patched vega-lite with silent empty-chart degradation (§1).
- Failure honesty: hermetic logs and surfaces (grounding caveats, warn-validation);
  Wren v1's dominant pattern is log-and-swallow-to-empty-dict (26 `except Exception`
  in src, e.g. `utils/sql.py:63-70`).
- In-code security enforcement for its threat model (§5).

## 8. Notable Wren v1 internals (for reference)

- Pipelines: 33 classes on Hamilton `AsyncDriver` DAGs (module-level functions as
  nodes wired by parameter name); Haystack used only for `PromptBuilder` + component
  decorators. Prompts are inline string literals (21 files), unversioned, zero
  snapshot tests.
- Async model: POST returns `query_id`; work in FastAPI `BackgroundTasks`; state in
  in-process `TTLCache`; `workers=1` pinned — single-process by construction. SSE
  streaming with a copy-pasted `_streaming_callback`/queue/`"<DONE>"` sentinel per
  pipeline.
- UI: no component over 565 lines (well-partitioned React) — god objects live
  server-side (`askingService.ts`, 1,191 lines, 18 injected fields, ~30 methods,
  five in-file `setInterval` poller classes).
- Dead code found: skipped test file; nonexistent-endpoint adaptor methods; duplicate
  `Instructions` class exports; corrector-class duplication; (HEAD) a 619-line MDL
  JSON Schema (`core/wren-mdl/mdl.schema.json`) referenced by **nothing** — the real
  contract is Rust serde, and the two can drift silently; a public no-op stub
  `decision_point_analyze` with zero callers.

## 9. Recommendations for hermetic

1. **Build an answer-quality eval harness** (the gap). Wren's execution-accuracy
   approach — run generated analysis vs. a gold answer and compare results — maps
   directly onto hermetic's sandbox + artifacts. Even 20 curated question/answer
   pairs over the sample datasets, scored offline, would measure what goldens can't.
2. **Adopt constrained decoding** for spec/JSON outputs where the provider supports
   it; keep prompt rules as the portable fallback.
3. **Adopt a banded error taxonomy** (user/internal/external + phase) — hermetic's
   error strings are ad hoc by comparison.
4. When Phase 2 packaging starts, Wren HEAD's per-module release automation and
   feature-flag boundary enforcement are the reference implementations.
5. Anti-patterns to keep guarding against (all observed in Wren): label-gated CI,
   hand-mirrored boundary types, silent degradation on validation failure, and
   schema files nothing references.
