# Test Plan — DAG Dependencies (Agentic Tier 1, Item #1)

_Last updated: 2026-05-31_

**Spec:** [`agentic-tier-1-implementation-plan-2026-05-31.md`](../agentic-tier-1-implementation-plan-2026-05-31.md) §"Item #1 — DAG dependencies"

---

## What this feature does

`PlannedSubQuestion.depends_on` changes from `number | null` to `number[]`. The Investigate planner can now emit plans where a single sub-question depends on multiple priors, and the orchestrator schedules each sub-question into the earliest wave where every listed predecessor has already completed.

Legacy plans that used the scalar `number | null` form still parse — the parser coerces them to `[]` or `[n]`.

Each completed predecessor contributes one `ConversationTurn` to the dependent's prior-turn context. Failed predecessors are skipped silently so a partial DAG still proceeds.

---

## Files changed

- `src/lib/llm/investigate-planner.ts`
  - Updated header comment to describe the DAG model.
  - Added `MAX_DEPENDS_PER_SUBQUESTION = 3` constant.
  - `PlannedSubQuestion.depends_on: number | null` → `number[]`.
  - Updated planner system prompt with multi-dep guidance + few-shot example.
  - New `normalizeDependsOn()` helper handles all the legal and illegal input shapes (null, scalar, array, junk). Exposed through `__testing` for unit tests.
  - `parsePlannerOutput()` calls the normalizer instead of the inline scalar check.
- `src/lib/pipeline/investigate-orchestrator.ts`
  - Updated header comment.
  - `SubQuestionResult.depends_on: number | null` → `number[]`.
  - Extracted the wave-grouping logic into a new pure exported helper `groupSubQuestionsIntoWaves()` that returns waves of original indices.
  - Wave-readiness check now requires `deps.every(d => indexInWave.has(d))`.
  - Prior-turn aggregation iterates `sq.depends_on` and pushes one `ConversationTurn` per completed predecessor (failed predecessors skipped).
- `src/lib/__tests__/investigate-planner.test.ts` — extended:
  - Existing "well-formed plan" test now asserts the new array form.
  - New test for the explicit array form including multi-dep `[0, 1]`.
  - Existing "normalizes invalid" test updated to assert `[]` instead of `null`.
  - New "strips forward and out-of-range entries" test.
  - New "caps depends_on arrays at MAX_DEPENDS_PER_SUBQUESTION" test.
  - New `normalizeDependsOn` test block covering 6 cases.
- `src/lib/pipeline/__tests__/investigate-orchestrator.test.ts` — **new**: 9 unit tests for `groupSubQuestionsIntoWaves`.

The single API route consumer (`src/app/api/query/investigate/route.ts:207`) just forwards `depends_on` to the client; the wire-protocol change to an array is benign because no current client component reads the field.

---

## Automated tests

```bash
npx vitest run src/lib/__tests__/investigate-planner.test.ts src/lib/pipeline/__tests__/investigate-orchestrator.test.ts
```

Expect: **30 passed** (21 planner + 9 orchestrator). Coverage:

**Planner (`investigate-planner.test.ts`)**

- `extractJsonObject`: passthrough, ` ```json ` fences, bare fences, surrounding text.
- `parsePlannerOutput`:
  - Legacy scalar form (`depends_on: 1`) coerced to `[1]`.
  - Array form with multi-dep `[0, 1]` preserved.
  - Min 2 sub-questions rule.
  - Sub-questions with `<5`-char text dropped.
  - Invalid values (`5` for index 0, `-1`, `"1"`) coerced to `[]`.
  - Forward / out-of-range / wrong-type entries stripped from arrays.
  - Hard cap at MAX_DEPENDS_PER_SUBQUESTION per sub-question.
  - Hard cap at 7 sub-questions per plan (existing).
  - Markdown-fenced output.
  - Invalid JSON / missing `subQuestions` → ParseError.
- `normalizeDependsOn`:
  - null/undefined/strings/booleans → `[]`.
  - Valid scalar wrapped in array.
  - Out-of-range / non-integer scalar → `[]`.
  - Arrays filtered to valid integer entries `< selfIndex`.
  - De-dup preserves first occurrence order.
  - Cap at MAX_DEPENDS_PER_SUBQUESTION.

**Orchestrator (`investigate-orchestrator.test.ts`)**

- All-independent → single wave.
- Linear chain → consecutive waves.
- Multi-dep `[0, 1]` → wave 2 with both priors in wave 0.
- Diamond DAG (0→1, 0→2, 1+2→3) → 3 waves.
- Multi-dep across different upstream waves → land after later wave.
- Duplicate sub-question objects use distinct indices.
- `undefined` depends_on treated as independent (defensive guard).
- Dependency cycle → flush remaining as parallel with a warning (no infinite loop).
- Empty plan → empty wave list.

```bash
npm run type-check
```

Expect: clean.

```bash
npm run lint
```

Expect: no errors (25 pre-existing warnings unrelated to this change).

---

## Manual smoke test

### Setup

1. Copy `data/test-fixtures/agentic-tier-1/dag-deps/sales-regions.csv` to a convenient location, or use the in-app file picker.
2. Start the dev server: `npm run dev`.
3. Open http://localhost:3000.
4. Upload `sales-regions.csv`.

### Test — multi-dep plan emitted and executed

Ask the **Investigate** form (not single-shot Ask):

> Compare the top and bottom performing regions on growth trajectory and seasonality.

Expected behavior:

1. The plan stream renders 3–5 sub-questions in the step list. One of them should reference both prior steps — natural decomposition:
   - Step 0: identify the top-performing region (e.g. North).
   - Step 1: identify the bottom-performing region (e.g. East or Central).
   - Step 2: compare their growth trajectories — `depends_on: [0, 1]`.
2. Steps 0 and 1 start in parallel. Both finish before step 2 begins.
3. The composer produces a dashboard with a region-ranking widget (step 0/1) and a side-by-side comparison chart (step 2).

If the planner picks a different (legitimate) decomposition that doesn't use multi-deps, ask a more pointed variant:

> First identify the highest-revenue region, then the lowest-revenue region. Then compare their year-over-year growth.

This forces a `[0, 1]` dependency. The expected plan / progress is identical.

### Test — legacy plan still parses

Existing saved investigations from before this change are stored as part of the conversation cache / history, not as raw `PlannedSubQuestion` JSON, so there's no on-disk migration concern. The back-compat test path is exercised by the unit tests (legacy scalar form).

If you have a stored conversation that re-enters Investigate, it should not break.

---

## Sample test data

`data/test-fixtures/agentic-tier-1/dag-deps/sales-regions.csv`

24 months (2024-01 → 2025-12) × 5 regions × revenue. Region characteristics:

| Region  | Trajectory                           | Range (USD) |
| ------- | ------------------------------------ | ----------- |
| North   | Steady linear growth (top performer) | 102k → 219k |
| South   | Moderate steady growth               | 68k → 106k  |
| East    | Steady decline                       | 71k → 41k   |
| West    | Strong seasonality (summer peak)     | 38k–84k     |
| Central | Flat / bottom performer              | 28k–33k     |

Clear top (North) and bottom (Central or East depending on metric used). 120 rows total.

---

## Risks observed during implementation

- **Wire-protocol change.** `depends_on` in the SSE plan payload (`/api/query/investigate/route.ts:207`) now serializes as an array. Grep confirms no current client component reads the field; the change is benign. If a future UI renders dependency arrows, it should consume the array directly.
- **Back-compat semantics.** The legacy parser dropped `depends_on: "1"` (a string) by setting it to `null`. The new normalizer preserves the same behavior — strings are not coerced to numbers — so model output that uses string-form indices continues to be treated as missing. This is conservative on purpose; if we later want to be more lenient we can add explicit string-to-number coercion.
- **Failed predecessor.** If a predecessor sub-question failed during execution, the prior-turn aggregator now skips it but keeps the other predecessors. This is a behavior change from the prior linear-chain model where a failed single predecessor meant the dependent got no prior context at all; the new behavior is strictly more useful.

---

## Out of scope

- Tier 2 multi-tool use.
- Re-planning loop (Tier 1, Item #3 — separate plan).
- Semantic result validation (Tier 1, Item #2 — separate plan).
- Composer-dispatched follow-ups (Tier 1, Item #4 — separate plan).
- Client-side dependency-graph visualization.
