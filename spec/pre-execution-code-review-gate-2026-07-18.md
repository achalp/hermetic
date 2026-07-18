# Pre-Execution Code Review Gate + Phase-Aware OOM Retry Signal

**Date:** 2026-07-18
**Branch:** `remote-cloud-parquet-source`
**Status:** Implemented, tested (33 tests), typechecked, lint-clean. Not yet committed.

## The problem this solves

Planet-scale spatial superlatives ("which building in the USA is farthest from its
nearest neighbor" — a nearest-neighbor query over 2.5B Overture rows) kept failing
with OOM, and **iterating the system-prompt guidance stopped working**. Two failures
in the same investigation proved the ceiling of the prose-guidance approach:

1. **The model edits away guardrails.** We added `assert n_geom == 1` guidance to
   catch a NULL region polygon. Opus adopted the code but replaced the assert with
   `pass  # removed hard-coded value assertion` — it read the literal `== 1` as a
   "hard-coded value" and deleted the guard. **Prose guardrails are not durable;
   the model rewrites them.**

2. **The retry loop was fed a misdiagnosis.** Run `52ade71f` OOM-killed at ~15 min.
   The generic OOM error we injected into the retry said _"drop string columns /
   switch to the counting strategy / N too large for a KD-tree."_ But that code was
   **already** coordinates-only, **already** counting per grid cell, **already**
   using a bounded leaf. Every remedy in the message was already done. So Opus's own
   `attempt-02` retry reproduced the **same structure** — `s = 10000.0` fixed 10 km
   grid + `cKDTree` over the full cells table — and would have OOM'd again. **The
   error message pointed away from the real cause.**

### What the real cause was

Direct comparison of the OOM'd run vs. an earlier **successful** run (`2f63fcbe`,
~11 min, ~100 MB) — identical algorithm shape (coarse GROUP-BY → cKDTree over
CELLS → bounded per-candidate DuckDB leaf) — isolated the difference to two lines:

|           | Successful run `2f63fcbe`                           | Failed run `52ade71f`                           |
| --------- | --------------------------------------------------- | ----------------------------------------------- |
| Cell size | `s = max(span_m/200, 2000)` → **~48 km** (adaptive) | `s = 10000.0` → **fixed 10 km**                 |
| Boundary  | none (pure bbox, leaks Canada)                      | `ST_Union_Agg` + `ST_Contains` polygon on cells |

A fixed 10 km cell over a ~5,000 km continent emits **hundreds of thousands to
millions of occupied cells** (~25× the adaptive run). At that count the _cells
DataFrame_ and the `cKDTree` built over it — normally tiny — are themselves the OOM.
The cKDTree over cells is fine when the cells table is small; it is the OOM when the
grid is too fine for the span. The successful run scaled the cell to the span, so its
cells table stayed at tens of thousands.

## The two changes

### 1. Phase-aware OOM retry signal (turn a misdiagnosis into a pinpoint)

The memory watchdog already tracked the current `progress()` phase label. Now:

- **`src/lib/sandbox/index.ts`** — the watchdog tags its abort marker with the phase
  where memory peaked: `HERMETIC_OOM_PREDICTED: [phase=materializing simplified USA
polygon] memory reached 90% ...`.
- **`src/lib/sandbox/parse-output.ts`** — the OOM branch recovers the phase (from the
  watchdog tag, or on a **hard kernel kill** with no marker, from the **last
  `__progress` line still in stdout**) and maps it to a **phase-specific remedy**:
  - polygon/boundary/union → _"simplify to 0.01, don't union raw full-detail geometry"_
  - grid/cell/count/scan → _"scale the cell to span/200; a fixed 10 km cell over a
    continent makes ~25× too many cells"_
  - leaf/neighbor/nearest → _"compute the distance as a DuckDB aggregate, no rings"_
  - load/read/materialize/df → _"aggregate in DuckDB, hydrate top-N by id"_
  - unmatched → falls back to the prior verbatim/generic message (no regression).

The retry now hears "memory peaked _building the polygon_ / _in the coarse scan_ —
fix _that_," instead of a generic blob the code already satisfied.

### 2. Pre-execution "lint critic" review gate

Instead of adding more generation-time instructions (which the model ignores or
edits away), a **separate model reviews the generated code before it runs**, framed as
pass/fail lint rules, and severe findings feed back for a redo.

- **`src/lib/pipeline/code-review.ts`** (new) — `reviewGeneratedCode()` sends the code
  to **Opus** (the critic, even when codegen is Sonnet) with the failure classes as
  rules. Returns `severe | minor | none` + injectable feedback. **Fail-open**: any
  error / unparseable verdict → `none`, so a flaky critic never blocks a run.
- **`src/lib/pipeline/orchestrator.ts`** — after codegen (both initial and retry),
  before execution: review → on **severe**, feed the findings back for a redo (bounded
  by `MAX_REVIEW_REDOS = 1`) → then run. **Gated to the geospatial/heavy path only**
  (`buildGeospatialGuidance !== ""`), so ordinary CSV questions pay nothing. Shared
  `generateFixedCode()` helper unifies the redo and the execution-retry code paths.
- **`src/lib/constants.ts`** — `CODE_REVIEW_MODEL = "claude-opus-4-8"`,
  `MAX_REVIEW_REDOS = 1`.
- New pipeline stages `reviewing_code` / `revising_code` (collapsed onto the codegen
  dot in the coarse stepper).

**The lint rules** (each a pass/fail check over concrete code, severe only when it
would actually hit at the data scale implied by the question):

| Rule              | Severe when                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEM-KDTREE`      | a scipy/sklearn index (cKDTree/KDTree/BallTree) is built over the RAW points of a large scan (KD-tree over a small aggregated CELLS table is fine) |
| `MEM-DF`          | `.df()`/`.fetchdf()`/`read_*` pulls an UNBOUNDED result into pandas (raw `SELECT *` / a full column of millions)                                   |
| `MEM-RING`        | a NN/leaf step reads a whole ring/radius of buildings into pandas, or accumulates rings across candidates                                          |
| `MEM-GEOM`        | `ST_Centroid`/`ST_X`/geometry(WKB) decode over millions of rows (derive the point from the bbox struct instead)                                    |
| `GRID-SCALE`      | a grid superlative uses a FIXED small cell regardless of region span                                                                               |
| `POLY-HEAVY`      | `ST_Union_Agg` over a country multipolygon without simplifying hard                                                                                |
| `ENGINE-BBOX`     | a named area filtered by a HARDCODED bbox instead of its boundary polygon (a bbox _pre_-filter before a polygon test is fine)                      |
| `ENGINE-PANDAS`   | filtering/joining that should be DuckDB SQL is done by looping in pandas over a large frame                                                        |
| `HARDCODE-EXTENT` | magic extents that should be DERIVED from the data are hardcoded (a clamp then silently excludes the target)                                       |
| `GUARD-NULL`      | a region polygon is used in `ST_Contains` without first asserting it is non-NULL                                                                   |

## Validation: replaying the failed run through the gate

Fed `attempt-01.py` (the OOM'd code) through the review critic → it returned three
severe findings: `GRID-SCALE`, `MEM-KDTREE`, `MEM-DF` (correctly pinpointing that at
10 km the cells table is _not_ small, so the cKDTree over it is the OOM — a sharper
diagnosis than the manual one). Fed those findings back to regenerate → the redo:

1. **Replaced `s = 10000.0` with `s = max(span_m/200, 25000)`** (span-scaled). For the
   USA span this lands at **~48 km — essentially identical to the successful run
   `2f63fcbe`.** The review moved the code from the OOM shape to the known-good shape.
2. **Restored the `assert n_geom == 1` NULL-polygon guard** that Opus had stripped
   (`GUARD-NULL`) — a bonus catch.
3. **Kept everything already correct** — the full-extent polygon build, the bounded
   DuckDB leaf reads, the `write_output` shape — untouched.

Contrast: production `attempt-02` (fed the _generic_ OOM message) kept `s = 10000.0`
and the cKDTree unchanged — it did **not** fix the grid scale. The review-driven redo
did, on the first pass.

## The durable lesson

For complex multi-step algorithms, three levers rank in reliability:

1. **Structural enforcement** (a sandbox-prelude cap the model can't delete) — most
   reliable, but not every rule is mechanically enforceable.
2. **A separate judging model** (this gate) — catches what generation-time
   instructions don't, because a critic that ONLY judges, with rules framed as
   pass/fail over concrete code, is a different and easier task than getting
   generation right the first time. Cheap (a few thousand tokens) vs. a 15-min remote
   scan that OOMs and burns a retry.
3. **Prose guidance in the system prompt** — least reliable; the model ignores it under
   load and even edits away guardrails written into the code.

Two feedback loops that were broken are now closed:

- **Before execution:** the critic catches the OOM/wrong-region shape and redoes it.
- **After a failure:** the retry error names the actual phase and its fix, instead of
  a generic message the code already satisfied.

See also: [[project_codegen_retry_hardening]], [[project_planet_scale_parquet]],
[[project_execution_control]], [[feedback_fix_root_cause_not_retreat]].

## Files

- `src/lib/pipeline/code-review.ts` (new) + `src/lib/pipeline/__tests__/code-review.test.ts`
- `src/lib/pipeline/orchestrator.ts` (review gate + shared `generateFixedCode`)
- `src/lib/sandbox/index.ts` (watchdog phase tag)
- `src/lib/sandbox/parse-output.ts` (phase extraction + phase-keyed hints) + tests
- `src/lib/constants.ts` (`CODE_REVIEW_MODEL`, `MAX_REVIEW_REDOS`)
- `src/lib/types.ts` + `src/components/app/status-indicator.tsx` (new stages)
