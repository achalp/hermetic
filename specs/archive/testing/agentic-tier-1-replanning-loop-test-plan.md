# Test Plan — Re-planning Loop (Agentic Tier 1, Item #3)

_Last updated: 2026-05-31_

**Spec:** [`agentic-tier-1-implementation-plan-2026-05-31.md`](../agentic-tier-1-implementation-plan-2026-05-31.md) §"Item #3 — Re-planning loop between waves"

---

## What this feature does

After every wave of sub-questions completes (and before the next is dispatched), the orchestrator calls a new re-planner LLM that sees:

- The original user question and approach.
- The full current plan (sub-questions + dep graph).
- Result summaries for every sub-question completed so far (status: success / degraded / failed, plus result-key types and chart shapes — **schema only**, no row values).
- The remaining pending sub-questions.
- Hop count and remaining budget.

The re-planner returns one of three actions:

- `continue`: plan stays unchanged, proceed to next wave.
- `amend`: append up to 3 new sub-questions and/or drop any of the pending ones.
- `stop`: skip remaining sub-questions, proceed to composition with what we have.

This is the keystone change that turns Investigate from a parallelized batch executor into an agentic loop. Combined with the DAG dependencies from item #1 and the semantic validation from item #2, it gets Hermetic to level 4 on the capability ladder defined in the assessment doc.

**Bounds (in `lib/constants.ts`):**

- `INVESTIGATE_MAX_HOPS = 2` — re-planner is consulted at most twice (so 3 wave-planning calls total: initial + 2 re-plans).
- `INVESTIGATE_MAX_SUBQUESTIONS = 10` — hard cap on plan size (initial + all amendments).

The re-planner is **only consulted when there are pending sub-questions** between waves. Composer-dispatched extensions at the very end are out of scope for #3 — they're item #4.

---

## Deferred items from #1 and #2 rolled into this change

**From Item #2 — degraded propagation:**

- `SubQuestionResult` now carries `degraded?: boolean` and `degradedReason?: string`, set when `PipelineResult.degraded === true`.
- New progress event `kind: "sub_degraded"` distinguishes a degraded sub-question from a hard failure in the live step-list UI.
- The composer (`investigate-composer.ts`) now sees per-step `degraded` and `removed` flags and is instructed to render a warning Annotation above degraded steps' visualizations rather than treating them as failures.
- The half-failure throw in `runInvestigation` no longer counts degraded sub-questions — they produced output the composer can annotate, so they shouldn't kill the whole investigation.

---

## Files changed

- `src/lib/constants.ts` — added `INVESTIGATE_MAX_HOPS = 2`, `INVESTIGATE_MAX_SUBQUESTIONS = 10`, `COMPOSER_MAX_DISPATCHES = 1` (#3 uses the first two; #4 will use the third).
- `src/lib/llm/investigate-planner.ts` — new `REPLANNER_SYSTEM_PROMPT`, new `generateReplan()` async function, new `parseReplannerOutput()` helper, new exported types `ReplanAction`, `ReplanDecision`, `SubQuestionResultSummary`. `__testing` seam exposes `parseReplannerOutput` for unit tests. Re-planner always falls back to `continue` on LLM or parse failure (forward progress > correctness).
- `src/lib/pipeline/investigate-orchestrator.ts` — rewritten `runInvestigation`:
  - Mutable plan: new sub-questions appended at the end; removed pending ones flagged with `removed: true`. Indices stay stable.
  - Wave loop is dynamic — `nextWaveIndices()` computes ready sub-questions each iteration, accounting for completed / failed / removed sets.
  - Between waves: if budget allows AND pending work remains, call `generateReplan()` → apply decision via `applyAmendment()`.
  - New progress event kinds: `sub_degraded`, `replan_decision`, `subs_amended`.
  - Hard upper bound `MAX_WAVES = INVESTIGATE_MAX_SUBQUESTIONS + 2` defends against pathological dep-chains.
  - `OrchestrateOptions` now requires `originalQuestion` and `approach`; optional `warehouse`.
  - `SubQuestionResult` gains `degraded`, `degradedReason`, `removed`.
- `src/lib/llm/investigate-composer.ts` — flatten-step-artifacts skips removed steps; per-step metadata gains `degraded` and `removed`; composer system prompt and user prompt updated to mention degraded steps; initial-state's `investigation.steps` includes both `failed` and `degraded`.
- `src/app/api/query/investigate/route.ts` — threads `originalQuestion` and `approach` into `runInvestigation`; handles three new progress event kinds:
  - `sub_degraded` → marks step status `"degraded"` and attaches `degradedReason`.
  - `replan_decision` → writes `/state/__plan/replan` with action + rationale + position.
  - `subs_amended` → appends new step entries to `/state/__plan/steps/` and marks removed ones with status `"removed"`.
- `src/lib/__tests__/investigate-planner.test.ts` — added a 10-test `parseReplannerOutput` block.
- `src/lib/pipeline/__tests__/investigate-orchestrator.test.ts` — added a 15-test `runInvestigation — agentic loop` block with `vi.mock` of `runPipeline` and `generateReplan`.

---

## Automated tests

```bash
npx vitest run src/lib/__tests__/investigate-planner.test.ts src/lib/pipeline/__tests__/investigate-orchestrator.test.ts
```

Expect: **55 passed** (31 planner + 24 orchestrator).

**Planner — `parseReplannerOutput`** (10 new tests):

- Accepts continue / stop / amend decisions.
- Strips forward `depends_on` in newly added sub-questions (selfIndex = currentPlanLength + position).
- Caps added sub-questions at 3.
- Filters out-of-range and dedupes remove indices.
- Rejects malformed JSON, invalid action values.
- Handles markdown-fenced output.
- Drops new sub-questions with too-short text.

**Orchestrator — `runInvestigation — agentic loop`** (15 new tests with `vi.mock`):

- All-`continue` re-planner runs every sub-question successfully.
- Re-planner called once per inter-wave boundary when there's pending work; zero calls when all sub-questions complete in wave 0.
- `amend` appends a new sub-question that runs in a subsequent wave.
- `stop` marks remaining pending sub-questions as `removed`.
- `removeSubQuestionIndices` drops pending entries; remove indices targeting completed sub-questions are silently ignored.
- `degraded` flag propagates from `PipelineResult` to `SubQuestionResult`.
- `sub_degraded` progress event emitted on degraded results (not `sub_failed`).
- `replan_decision` progress event emitted after every re-plan call.
- `subs_amended` progress event includes added steps' indices/questions and removed indices.
- `INVESTIGATE_MAX_SUBQUESTIONS = 10` cap enforced on amendments.
- `INVESTIGATE_MAX_HOPS = 2` cap enforced on re-planner calls.
- Degraded sub-questions do not count toward the half-failure throw.
- Half-or-more HARD failures throws as before.

```bash
npm run type-check
```

Expect: clean.

```bash
npm test
```

Expect: **416 passed** (was 391 before #3; +25 across re-planner and orchestrator suites).

```bash
npm run lint
```

Expect: no errors (25 pre-existing warnings unrelated to this change).

---

## Manual smoke test

### Setup

1. Start the dev server: `npm run dev`.
2. Open http://localhost:3000.

### Test 1 — amend after a concentrated finding

1. Upload `data/test-fixtures/agentic-tier-1/replan-amend/customer-churn.csv`.
2. Ask via **Investigate** (not single-shot Ask):

   > Why did churn spike in late 2024?

3. Expected behavior:
   - Initial plan: 3–5 sub-questions covering overall trend + by-segment + maybe time-of-onset.
   - Wave 0 returns: churn rate by segment shows that Self-Serve drives essentially all of the late-2024 spike (Aug 2024 onwards: ~1180–1780 churns/month vs. baseline ~420–510).
   - **Re-planner sees this concentration and amends the plan with at least one new sub-question** — typically "Drill into Self-Serve churn patterns from August 2024 onward" or "Compare Self-Serve churn rate to other segments month-over-month".
   - UI shows a "Planner re-evaluated" entry between waves with the rationale.
   - New sub-question(s) appear in the step list with the `addedByReplanner: true` flag (the UI can style these distinctly if/when that's wired up).

   Server log lines to look for:

   ```
   [INFO] Investigate: re-planning { hopCount: 0, completed: N, pending: M }
   [INFO] Investigate: re-plan decision { action: 'amend', add: 1, remove: 0 }
   [INFO] Investigate: plan amended { added: 1, removed: 0, newTotal: N+1, startIndex: ... }
   ```

### Test 2 — stop when findings are uninteresting

1. Upload `data/test-fixtures/agentic-tier-1/replan-stop/flat-metrics.csv` (8 weeks × 2 regions × 2 products with near-constant signups and revenue).
2. Ask via Investigate:

   > Find what's driving variance in this dataset.

3. Expected behavior:
   - Initial plan: 3–4 sub-questions covering variance by region, by product, by week.
   - Wave 0 returns: variance is statistically uninteresting (~±5% noise around 80 signups / 40 signups).
   - **Re-planner may return `stop`** with a rationale like "No meaningful variance to drill into; the dataset is essentially flat."
   - Pending sub-questions are marked `removed` in the UI step list.
   - Composer still produces a dashboard summarizing what was learned (essentially "everything is flat") with the dropped steps annotated.

   Server log lines:

   ```
   [INFO] Investigate: re-plan decision { action: 'stop', ... }
   ```

   Note: the re-planner may also choose `continue` here if it thinks remaining sub-questions might surface something. This is OK — the test demonstrates the **option** to stop, not a guarantee.

### Test 3 — budget enforcement

Construct a deeply chained investigation (use the sales-regions.csv from item #1's fixtures and ask something requiring multiple steps). Open the network panel and verify:

- At most `INVESTIGATE_MAX_HOPS = 2` calls to `generateReplan` server-side per investigation.
- Plan never exceeds `INVESTIGATE_MAX_SUBQUESTIONS = 10` sub-questions total, even if the re-planner asks for more.

---

## Sample test data

- `data/test-fixtures/agentic-tier-1/replan-amend/customer-churn.csv` — 48 rows. 12 months × 4 segments (Enterprise, Mid-Market, SMB, Self-Serve) × `active_customers` + `churned_customers`. Self-Serve has a dramatic late-2024 churn spike (~3× baseline starting August) concentrated in one segment. Designed so wave 0 surfaces the concentration, prompting the re-planner to amend with a drill-down.
- `data/test-fixtures/agentic-tier-1/replan-stop/flat-metrics.csv` — 32 rows. 8 weeks × 2 regions × 2 products with near-constant signups (~80 / 40) and revenue (~4000 / 8000). Designed so the re-planner sees nothing interesting to drill into and may return `stop`.

---

## Risks observed during implementation

- **Re-planner cost.** Each between-wave call is one LLM round trip. With `MAX_HOPS = 2`, an investigation costs at most 2 extra calls beyond the planner + per-step + composer. At Sonnet pricing, roughly 1–2 cents extra per investigation. Caching would help if many users run similar Investigates; deferred.
- **UI noise from continue decisions.** Every between-wave `continue` emits a `replan_decision` event. If the UI renders all of them, the step list could feel busy. The route emits these to `/state/__plan/replan` (a single slot), so the UI sees only the most recent. If we later want to render a timeline, we should change the path to a per-call slot.
- **Re-planner LLM failure handling.** `generateReplan()` falls back to `continue` on parse failure or LLM error so the investigation can always make forward progress. This is intentional — a broken re-planner shouldn't kill an in-flight Investigate.
- **Amend with new deps referencing already-completed steps.** The parser allows new sub-questions to depend on indices 0..N-1 of the current plan (including already-completed ones). The orchestrator's `nextWaveIndices` correctly schedules these because completed indices are in the `completed` set. Tested.
- **Removed sub-questions stay in `results`.** They retain their slot for index stability (so subsequent dep references aren't broken) but have `removed: true`. The composer skips them. The client UI marks them status="removed" via the SSE patch.
- **Hard upper bound `MAX_WAVES`.** Defends against the worst case where the re-planner creates self-referential chains that confuse the wave grouper. Set to `INVESTIGATE_MAX_SUBQUESTIONS + 2 = 12`, generous enough not to bite legitimate plans.

---

## Out of scope

- Tier 2 multi-tool use.
- Composer-dispatched follow-ups (Tier 1, Item #4 — separate plan).
- Cross-investigation memory.
- Hypothesis-driven mode.
- Open-ended exploration ("find what's interesting" without a starting question).
- Drill-as-sub-investigation for follow-up questions.
- Client UI styling for `addedByReplanner: true` steps (the data is in the SSE patch; visual treatment can be done in a small standalone UI ticket).
- Composer-level error message when an investigation ends with `degraded` steps (a simpler "warning" annotation is now emitted by the composer, but a top-of-dashboard banner could come later).
