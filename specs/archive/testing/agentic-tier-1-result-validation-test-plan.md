# Test Plan — Semantic Result Validation (Agentic Tier 1, Item #2)

_Last updated: 2026-05-31_

**Spec:** [`agentic-tier-1-implementation-plan-2026-05-31.md`](../agentic-tier-1-implementation-plan-2026-05-31.md) §"Item #2 — Semantic result validation"

---

## What this feature does

The single-shot pipeline (`runPipeline`) now retries on **degenerate-but-successful** executions, not only on exceptions. After every successful sandbox execution, a pure validator inspects the `executionResult.results` and `executionResult.chart_data` and returns a verdict. If the verdict flags a degenerate result, the pipeline retries with a reflection prompt that includes the validator's reason + suggested fix.

Semantic failures count against the same `MAX_RETRIES = 3` budget as exception failures. If the budget is exhausted on semantic failures (no recovery), the pipeline returns the result with `degraded: true` and `degradedReason: string` rather than throwing.

Validation runs on **every** pipeline call, so single-shot Ask benefits too — not just Investigate sub-questions.

The validator is conservative on purpose. Implemented checks:

1. **Both `results` and `chart_data` are empty** → "Execution produced no results or chart data."
2. **A `chart_data[k]` array of length 0** → `"Chart \"k\" has no rows."`
3. **The only `results[k]` is JS NaN / `null` / string `"nan"` / `"None"` / `"null"`** → flag.
4. **All `results[k]` values are degenerate** (when there are multiple keys) → flag.
5. **A `chart_data[k]` array of length > 1 where every numeric column is exactly 0** → flag.

Deliberately **not** flagged in v1:

- Length-1 `chart_data` arrays (could legitimately be a KPI).
- Single `null` among many valid `results` (legit "no data for this segment").
- Chart data with non-numeric columns only (no metric to validate).
- A single `null` or `NaN` value mixed with valid numerics in a multi-row chart (legit missing-data gap).

---

## Files changed

- `src/lib/pipeline/result-validator.ts` — **new**: `validateExecutionResult()` + `formatSemanticVerdictForRetry()`. Pure, no I/O, no LLM calls.
- `src/lib/pipeline/orchestrator.ts`:
  - Imports the validator.
  - `PipelineResult` gains optional `degraded?: boolean` and `degradedReason?: string` fields.
  - Retry loop refactored: each iteration either (a) reads `result.error` for execution failures or (b) reads the validator verdict for semantic failures, and converts whichever applies into the retry-prompt string.
  - On budget exhaustion: execution failures still throw; semantic failures return with `degraded: true`.
  - Existing logging extended with `kind: "semantic" | "execution"` per retry.
- `src/lib/pipeline/__tests__/result-validator.test.ts` — **new**: 15 unit tests covering each check, false-positive guards (single null among valid results, length-1 zeros, string-only columns), defensive handling of missing fields, and verdict formatting.

---

## Automated tests

```bash
npx vitest run src/lib/pipeline/__tests__/result-validator.test.ts
```

Expect: **15 passed**. Coverage:

- Healthy result → ok.
- Blank results + blank chart_data → flagged with the fundamental reason.
- Empty chart_data array → flagged with chart name.
- Single-result JS NaN → flagged.
- Single-result null / `"nan"` / `"NaN"` / `"None"` / `"null"` / `"  none  "` (case + whitespace) → all flagged.
- Single null among many valid results → NOT flagged.
- All multi-result values degenerate → flagged.
- Multi-row chart_data, every numeric column zero → flagged.
- Length-1 chart_data of zeros → NOT flagged (KPI guard).
- Mixed zero + non-zero numeric column → NOT flagged.
- String-only chart_data columns → NOT flagged.
- Reason priority: "no results or chart data" preferred over more specific failures.
- Defensive: missing `results` / `chart_data` keys don't crash.
- Verdict formatter: empty string on ok, reason + fix on failure.

```bash
npm run type-check
```

Expect: clean.

```bash
npm test
```

Expect: **391 passed**. The orchestrator's existing tests (e.g. edit-rerun) are unaffected because `runPipelineWithCode()` is a separate code path that does not call the validator (edited code returns raw output by design — see `runPipelineWithCode` docstring).

```bash
npm run lint
```

Expect: no errors (25 pre-existing warnings unrelated to this change).

---

## Manual smoke test

### Setup

1. Start the dev server: `npm run dev`.
2. Open http://localhost:3000.

### Test 1 — Empty filter recovers via semantic retry

1. Upload `data/test-fixtures/agentic-tier-1/result-validation/sales-2024.csv` (12 months × 4 categories of 2024 sales).
2. Use **single-shot Ask** (not Investigate) and ask:

   > What were total sales in Q5 of 2024?

   There is no Q5; the LLM may produce code that returns an empty DataFrame.

3. Expected behavior in the streaming UI:
   - First execution returns nothing useful.
   - Pipeline retries once (or up to three times) with the semantic-validation reflection prompt.
   - Either the LLM recovers (most likely outcome: it returns a result saying "Q5 does not exist" with full-year sales or quarter-by-quarter breakdown), OR
   - The pipeline returns with `degraded: true`, which surfaces in server logs as `Pipeline returning degraded result` and to the composer as a degraded flag.

   Server log lines to look for:

   ```
   [INFO] Pipeline retrying { attempt: 1, kind: 'semantic', errorPreview: 'Semantic failure ...' }
   ```

4. Confirm healthy questions still work without extra retries — ask:

   > What were total sales by month in 2024?

   Should produce a 12-row chart and **no** retry log lines.

### Test 2 — Filter collision

1. Upload `filter-collision.csv` (orders with a product line literally named "2024" alongside year-spanning data from 2023–2025).
2. Ask:

   > What were 2024 sales by product line?

   A buggy filter (e.g. `df[df['product_line'] == '2024']`) would return only the "2024" product-line rows, an all-zeros result for other product lines, or a one-row aggregate. The validator should catch the degenerate shape if it manifests.

3. Expected behavior: the LLM should recognize `order_date` vs `product_line` and produce a healthy by-product-line breakdown filtered by date. If it does not, the validator retries. If still degenerate after retries, `degraded: true` is set on the returned `PipelineResult`.

### Test 3 — Healthy run has zero overhead

Ask any standard question on either fixture and confirm:

- No `Pipeline retrying` log lines.
- No `Pipeline returning degraded result` log lines.
- Latency unchanged vs. pre-change (validator is sub-millisecond on typical payloads).

---

## Sample test data

- `data/test-fixtures/agentic-tier-1/result-validation/sales-2024.csv` — 48 rows. 12 months × 4 categories (Electronics, Apparel, Home, Books). All revenue values positive. Designed to make "Q5 2024" return an empty DataFrame.
- `data/test-fixtures/agentic-tier-1/result-validation/filter-collision.csv` — 24 rows. Includes a `product_line` column whose values include a category literally named `"2024"`. Designed so a naive `== '2024'` filter against the wrong column produces a one-product-line subset rather than the year filter the user asked for.

---

## Risks observed during implementation

- **False positives on legitimately small results.** Mitigated by:
  - Length-1 chart_data of all-zeros is NOT flagged (could be a baseline KPI).
  - A single null/NaN among many valid result keys is NOT flagged (legit "no data for one segment").
  - The validator only flags an all-degenerate multi-result block, not a single bad value.
- **Retry budget exhaustion on hard-to-recover cases.** `degraded: true` is now a clean signal. The composer (when Investigate uses this pipeline) can render an `Annotation` rather than failing the whole investigation.
- **Validator performance.** Pure O(rows × cols) JSON traversal; no I/O; measured at < 1ms on typical payloads (verified informally during test runs). No need for short-circuit budget at this scale.
- **Single-shot Ask now retries on degenerate results.** This is intentional (the spec calls it out as an Ask-side benefit) but it does add latency for genuinely-degenerate user questions. Mitigated by the conservative validator design — false-positive retry rates should be very low.
- **Length-1 chart_data ambiguity remains.** The spec called for inspecting chart-type hints from code-gen to disambiguate, but those hints don't actually exist as a structured signal at validation time (chart type is decided downstream in the UI-composition step). Deferred to a future enhancement. In practice, length-0 catches the vast majority of broken comparison cases.

---

## Out of scope

- Tier 2 multi-tool use.
- DAG dependencies (Tier 1, Item #1 — separate plan).
- Re-planning loop (Tier 1, Item #3 — separate plan).
- Composer-dispatched follow-ups (Tier 1, Item #4 — separate plan).
- Surfacing `degraded: true` to the UI as a visible warning (today it appears in server logs and `PipelineResult` only; the composer / UI integration follows in Item #3 or as a small standalone UI ticket).
- Adding chart-type hints to code-gen so length-1 array validation can be added safely.
