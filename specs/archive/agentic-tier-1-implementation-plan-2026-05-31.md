# Agentic Tier 1 — Implementation Plan

_Last updated: 2026-05-31_

**Source of priorities:** [`agentic-data-analysis-assessment-2026-05-31.md`](./agentic-data-analysis-assessment-2026-05-31.md) §3.1 — the four Tier 1 items that close the four highest-leverage gaps between Hermetic's current Investigate stack and a true agentic loop.

**Strategic intent:** flip Investigate from a parallelized batch executor (level 2.5 on the capability ladder) to a re-planning agent with DAG dependencies and semantic self-debugging (level 4). After these four items ship, Hermetic can be honestly classified as a true agentic data analysis tool by the working definition the field has converged on.

This is **not** a Tier 2 plan (multi-tool use) or a Tier 3 plan (memory, hypotheses, open-ended). Those follow once Tier 1 is solid and we have telemetry on real investigations.

---

## Implementation order and protocol

| Order | Item                                  | Est. days | Why this slot                                                                                                                                |
| ----- | ------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | **#1 DAG dependencies**               | 2–3       | Smallest lift, pure data-model change. Unblocks richer plans before any agent loop work. Lowest risk of breaking Investigate.                |
| 2     | **#2 Semantic result validation**     | 3–4       | Localized to per-step retry logic. Independently valuable for single-shot Ask, not just Investigate. Prepares ground for #3.                 |
| 3     | **#3 Re-planning loop between waves** | 5–7       | The keystone change — touches the orchestrator's wave loop and adds a new planner mode. Riskiest; do once #1 and #2 reduce surface variance. |
| 4     | **#4 Composer-dispatched follow-ups** | 3–4       | Final loop closure. Composer becomes a participant in the agent loop, not just a sink. Safer to do after #3 lands.                           |

**Per-item protocol** (carried over from [`tier-1-implementation-plan-2026-04-25.md`](./tier-1-implementation-plan-2026-04-25.md)):

1. Implement against the spec below.
2. `npm run type-check` and `npm run lint` must pass.
3. Author tests where appropriate (Vitest for unit logic; manual UI smoke test instructions for component / streaming work).
4. **Check-in:** brief status report to user with the diff summary, type-check/test results, and outstanding caveats — pause for user direction before proceeding.
5. Write a per-item testing document at `spec/testing/agentic-tier-1-{item-slug}-test-plan.md`.
6. Drop sample test data at `data/test-fixtures/agentic-tier-1/{item-slug}/` where applicable.
7. Move to next item.

**Out of scope across the board:**

- Tool use beyond Python / SQL code-gen (Tier 2).
- Cross-investigation memory (Tier 3).
- Hypothesis-driven mode (Tier 3).
- Open-ended exploration (Tier 3).
- Changes to the single-shot Ask pipeline beyond what #2 needs (semantic validation is shared; nothing else).
- Frontend / UI changes beyond what's needed to surface the new states (the existing step-list UI in `analysis-history` / Investigate progress stream should accommodate the loop with minor additions).

**Cost budget:** each investigation must remain bounded. Add a global `INVESTIGATE_MAX_SUBQUESTIONS = 10` and `INVESTIGATE_MAX_HOPS = 2` constant (max additional waves the re-planning loop can produce). Surface both in `lib/constants.ts`.

---

## Item #1 — DAG dependencies

### Goal

Let a sub-question depend on **multiple** prior sub-questions, not just one. This unlocks plans like "compare the top region from step 1 with the bottom region from step 2" that the current data model can't express.

### Why now

Smallest lift, lowest risk. The orchestrator's wave grouping already iterates dependencies in a loop; the change is from "in the set" to "all in the set". The planner just needs prompt-level guidance to emit arrays. The conversation-context aggregator needs to handle multiple priors.

### Design

- **Type change:** `PlannedSubQuestion.depends_on: number | null` → `depends_on: number[]`. Empty array = independent. Parser back-compat: accept the legacy `number | null` form and coerce to `[]` or `[n]`.
- **Planner prompt update:** explicit instruction and one few-shot example showing multi-dep usage. Cap `depends_on.length ≤ 3` to keep context bounded.
- **Orchestrator wave grouping:** in `runInvestigation()`, change the readiness check from `sq.depends_on === null || indexInWave.has(sq.depends_on)` to `sq.depends_on.every(d => indexInWave.has(d))`. Cycle-detection logic stays the same (empty `ready` set = malformed plan).
- **Prior-turn aggregation:** `turnFromResult()` returns one `ConversationTurn`. When a sub-question has multiple priors, build a synthetic combined turn whose `analysisSummary` merges the result-key types and chart-data shapes from each prior. The composer already prefixes step artifacts with `step_<N>_` so namespace collision isn't an issue.
- **Validation:** in `parsePlannerOutput()`, reject any `depends_on` entry that's `>= i` (forward dep) or `< 0`. Already true for the legacy scalar form; extend to the array.

### Files touched

- `src/lib/llm/investigate-planner.ts` — type, prompt, parser, validation.
- `src/lib/pipeline/investigate-orchestrator.ts` — wave grouping, prior-turn aggregation.
- `src/lib/__tests__/investigate-planner.test.ts` (new) — parser back-compat, multi-dep parsing, forward-dep rejection.
- `src/lib/__tests__/investigate-orchestrator.test.ts` (new) — wave grouping with multi-deps, cycle handling.

### Acceptance criteria

- [ ] Planner can emit `depends_on: [0, 1]` and the orchestrator schedules the dependent in wave 2 (or later).
- [ ] Legacy plans with `depends_on: 2` still parse and run as `[2]`.
- [ ] Forward dependencies (`depends_on: [3]` on sub-question index 1) are stripped to `[]` with a logged warning.
- [ ] Multi-dep prior context is visible in the dependent sub-question's generated code (manual check: the generated code references both upstream result names).
- [ ] `npm run type-check` and `npm run lint` pass.
- [ ] Vitest covers parser back-compat + wave grouping.

### Risks

- **Planner emits over-deep DAGs.** Mitigation: cap `depends_on.length ≤ 3` in the parser, log + truncate if exceeded.
- **Combined `ConversationTurn` exceeds context budget.** Mitigation: cap the merged turn's `analysisSummary` to the union of result keys (no values), and `chartDataShapes` to the first 5 chart entries per prior.

### Sample test data

`data/test-fixtures/agentic-tier-1/dag-deps/sales-regions.csv` — 24 months × 5 regions × revenue, with one region as a clear top performer and another as a clear bottom performer. Question: "Compare the top and bottom performing regions on growth trajectory and seasonality." The natural plan has steps 0+1 identifying top/bottom independently and step 2 depending on `[0, 1]`.

---

## Item #2 — Semantic result validation

### Goal

Detect "the code ran but the result is degenerate" cases — empty DataFrames, NaN-only columns, single-bar charts, zero-row chart_data — and treat them as soft failures that trigger a retry with a "your last result looked degenerate" reflection prompt.

Today the per-step retry fires only on exceptions. SOTA agents (AIDE, Data Interpreter) inspect result quality and retry differently. This is the single highest-leverage reliability change short of the re-planning loop itself.

### Why now

Independently valuable for single-shot Ask, not just Investigate. Reduces the rate of "successful" runs that produce a one-bar chart or a stat card reading `NaN`. Surfaces clean signals that the re-planning loop in #3 will need to consume anyway.

### Design

- **Validator** (`src/lib/pipeline/result-validator.ts`, new): pure function `validateExecutionResult(exec: SandboxExecutionResult): ValidationVerdict`.
  - Return shape: `{ ok: true } | { ok: false, reason: string, suggestedFix: string }`.
  - Checks (each independent, all checked):
    1. `Object.keys(exec.results).length === 0 && Object.keys(exec.chart_data).length === 0` → "Execution produced no results or chart data."
    2. Any `results[k]` whose value is `NaN`, `null`, or a string `"nan"`/`"None"` → "Result `k` is null/NaN."
    3. Any `chart_data[k]` array with `length === 0` → "Chart `k` is empty."
    4. Any `chart_data[k]` array of length 1 where the chart type is comparison-like (bar, line, scatter, area) → "Chart `k` has only one data point."
    5. Any `chart_data[k]` where every row's numeric columns are 0 → "Chart `k` is entirely zeros."
  - `suggestedFix` is a short hint the retry prompt will inline: "Check the filter clause", "Verify the aggregation key", "Ensure the date column is parsed correctly", etc.
- **Pipeline integration** in `runPipeline()`:
  - After the existing sandbox `executeSandbox()` call, if execution succeeded, run the validator.
  - If `validator.ok === false`, push the verdict onto the `attempts` list with `kind: "semantic"` and treat as a retryable failure.
  - The existing retry loop already runs up to `MAX_RETRIES = 3`. Semantic failures count against the same budget. After the budget is exhausted, the result is returned as-is with a `degraded: true` flag on `PipelineResult` (new optional field) so the composer can annotate it.
- **Retry prompt:** extend `buildRetryPromptMulti()` to include semantic verdicts alongside exception messages. Format:

  ````
  Attempt N failed semantically: <reason>
  Suggested fix: <suggestedFix>
  Code that produced the degenerate result:
  ```<code>```
  ````

- **Single-shot Ask:** the validator runs there too — same code path, so Ask gets the reliability win for free.
- **Telemetry:** log `validation_verdict` on every pipeline run so we can measure how often degenerate results currently slip through.

### Files touched

- `src/lib/pipeline/result-validator.ts` (new) — validator.
- `src/lib/pipeline/orchestrator.ts` — integrate validator into retry loop, add `degraded` flag.
- `src/lib/llm/prompts.ts` — extend retry prompt builder for semantic verdicts.
- `src/lib/types.ts` — add `PipelineResult.degraded?: boolean`.
- `src/lib/pipeline/__tests__/result-validator.test.ts` (new) — each check, plus the "all-zero numeric columns" edge case.

### Acceptance criteria

- [ ] A pipeline that returns an empty DataFrame for a "what is the total revenue in Q5 of 2024" question (no Q5) is retried with a reflection prompt and either recovers or returns `degraded: true`.
- [ ] A pipeline that returns a one-bar bar chart for "compare 2024 to 2025" (filter bug) is retried and either recovers or returns `degraded: true`.
- [ ] Healthy runs (non-empty, non-NaN, multi-bar charts) are unaffected — no extra retries, no perf regression.
- [ ] Single-shot Ask benefits from the same validator (manual smoke).
- [ ] `npm run type-check` and `npm run lint` pass.
- [ ] Vitest covers each validator check independently.

### Risks

- **False positives on legitimately small results.** A KPI question genuinely has one row. Mitigation: validator does NOT flag `chart_data` arrays of length 1 when the spec uses single-value components (StatCard, BulletChart). Wire the chart-type signal in by inspecting the chart-type hints emitted by code-gen, not by inspecting the rendered spec (which doesn't exist yet at this stage).
- **Retry budget exhaustion on hard-to-recover cases.** Mitigation: `degraded: true` is a clean signal; the composer surfaces it as an Annotation rather than failing the investigation.
- **Validator becomes a tax on every run.** Mitigation: validator is pure O(rows + cols) over already-loaded JSON. No I/O. Profile and bail if it exceeds 5ms on a 10k-row chart.

### Sample test data

- `data/test-fixtures/agentic-tier-1/result-validation/sales-2024.csv` — 12 months × 4 categories. Asking for "Q5 2024 revenue" produces an empty result; the validator should flag it.
- `data/test-fixtures/agentic-tier-1/result-validation/filter-collision.csv` — has a category named "2024" that collides with year filtering; a buggy filter produces a one-bar chart that the validator should flag.

---

## Item #3 — Re-planning loop between waves _(keystone)_

### Goal

After each wave completes, send the planner the wave's result summaries and let it decide: (a) keep the plan, (b) add 1–3 new sub-questions, or (c) abandon downstream sub-questions that are no longer informative.

This is the single biggest change. It is what flips Investigate from "smart batch executor" to "agent".

### Why now

#1 (DAG deps) and #2 (semantic validation) reduce the surface variance and give the re-planner cleaner inputs. Doing this third means the re-planner can already consume DAG plans and trust that "successful" sub-questions actually produced meaningful results.

### Design

- **New planner mode** in `investigate-planner.ts`: `RE_PLANNER_SYSTEM_PROMPT` and `generateReplan(currentPlan, completedResults, schema, hopCount)`.
- **Re-planner input:**
  - The original question.
  - The current plan (approach + all sub-questions with their depends_on graph).
  - For each completed sub-question: question, rationale, success/degraded/failed status, and a `resultSummary` — first 10 keys of `results` (with types only, no values) and `chartDataShapes` from each chart_data entry. Capped at ~3 KB total per sub-question.
  - The remaining (pending) sub-questions.
  - Hop count (how many re-plan cycles already happened).
- **Re-planner output** (strict JSON):
  ```json
  {
    "action": "continue" | "amend" | "stop",
    "rationale": "1-2 sentence summary of the decision",
    "addSubQuestions": [/* PlannedSubQuestion array, empty if not amending */],
    "removeSubQuestionIndices": [/* indices of pending sub-questions to drop */]
  }
  ```
- **Orchestrator changes** in `runInvestigation()`:
  - After each wave's `Promise.all` resolves, if `hopCount < INVESTIGATE_MAX_HOPS` and `subQuestions.length < INVESTIGATE_MAX_SUBQUESTIONS`, call the re-planner.
  - `continue`: no change, proceed to next wave.
  - `amend`: append new sub-questions to `subQuestions[]` (with indices renumbered consecutively); rebuild the remaining-waves grouping; drop the indicated indices from pending waves.
  - `stop`: skip remaining waves, jump to composer with what's accumulated.
  - Emit a new progress event `kind: "replan_decision"` with the action and rationale so the UI can render it as a step in the live step-list.
- **Bounded loop:** `INVESTIGATE_MAX_HOPS = 2` (so at most 3 waves of planning total: initial + 2 re-plans). `INVESTIGATE_MAX_SUBQUESTIONS = 10`. Both surfaced in `lib/constants.ts`.
- **UI surface:** the existing Investigate progress UI shows a vertical step list. Add a new step type "Planner re-evaluated" with the rationale shown inline. No structural UI rebuild — just a new event kind to handle.
- **Telemetry:** log `replan_decision` events with hop count, decision, count_added, count_removed.

### Files touched

- `src/lib/llm/investigate-planner.ts` — new system prompt, `generateReplan()`, output parser.
- `src/lib/pipeline/investigate-orchestrator.ts` — wave loop becomes a `while (more waves || re-planner extends)` loop; progress event kind extended.
- `src/lib/constants.ts` — `INVESTIGATE_MAX_HOPS`, `INVESTIGATE_MAX_SUBQUESTIONS`.
- `src/app/api/query/route.ts` — pipe new `replan_decision` events through the SSE stream.
- `src/components/app/analysis-history.tsx` (or wherever Investigate progress renders) — render the new event type.
- `src/lib/__tests__/investigate-orchestrator.test.ts` — re-planner integration, hop cap, sub-question cap, cycle prevention.

### Acceptance criteria

- [ ] An investigation where wave 0 surfaces a clear anomaly (e.g. one region dominates) prompts the re-planner to **amend** with "drill into top region by month" and that new sub-question runs.
- [ ] An investigation where wave 0 shows nothing interesting prompts the re-planner to **stop** rather than continue with pre-planned but now-irrelevant sub-questions.
- [ ] Hop cap of 2 is enforced (3rd amendment ignored, logged).
- [ ] Sub-question cap of 10 is enforced (amendments beyond cap are truncated, logged).
- [ ] Re-planner failures (JSON parse, LLM timeout) fall back gracefully to `continue` — never block the investigation.
- [ ] UI shows a "Planner re-evaluated" step between waves with rationale.
- [ ] `npm run type-check` and `npm run lint` pass.

### Risks

- **Runaway investigations.** Mitigated by hop cap (2) and sub-question cap (10), both hard. The re-planner cannot extend past either, regardless of what it emits.
- **Re-planner cost.** Each re-plan call is one LLM round trip per wave (so up to 2 extra calls per investigation). At Haiku pricing (~$1/M input + ~$5/M output) and ~3 KB input + ~500 token output, this is sub-cent per investigation. No cache layer needed at this scale.
- **Re-planner emits over-correlated additions.** Mitigation: re-planner prompt explicitly says "do not duplicate the rationale of existing sub-questions"; the parser de-dupes on rationale similarity (Jaccard on word tokens > 0.7 → drop). This is heuristic and cheap.
- **UI noise from many re-planner steps.** Mitigation: collapse identical-rationale events; only render when action ≠ `continue`.

### Sample test data

- `data/test-fixtures/agentic-tier-1/replan-amend/customer-churn.csv` — 12 months × 4 segments. Q1 has a churn spike concentrated in one segment. Wave 0 (overall trend + by-segment trend) reveals the segment concentration → re-planner should add "Drill into segment X by churn reason".
- `data/test-fixtures/agentic-tier-1/replan-stop/flat-metrics.csv` — flat metrics across all dimensions. Wave 0 shows nothing interesting → re-planner should stop early.

---

## Item #4 — Composer-dispatched follow-ups

### Goal

Let the composer return either a final spec OR a request for 1–2 additional sub-questions before it can compose. This closes the loop on "I need one more data point to write a coherent conclusion."

### Why now

Final loop closure. By this point #3 has the agent re-planning between waves; #4 puts the same authority in the composer's hands. Safer to do last because the composer's existing one-shot mode is what the rest of the system trusts as the terminator — a buggy composer-dispatch can manifest as an infinite loop in a way the rest of the agent can't.

### Design

- **Composer becomes two-mode.** Add a `mode: "compose" | "gap-check"` parameter to `composeInvestigation()`.
- **First call** is `mode: "gap-check"`. Composer emits strict JSON: `{ "needs": [/* up to 2 sub-questions */] } | { "needs": [] }`.
  - If `needs.length === 0`, proceed to `mode: "compose"`.
  - If `needs.length > 0` and the composer-dispatch budget isn't exhausted, dispatch them as a new wave in the orchestrator, wait for results, then re-call `mode: "gap-check"`. Max **one** composer-dispatched wave per investigation.
- **Second call** is `mode: "compose"` and produces the final spec as today.
- **Orchestrator integration:** after the re-plan loop terminates (all planned waves done), the orchestrator calls the composer in `gap-check` mode. If the composer asks for follow-ups and the dispatch budget is available, the orchestrator schedules a final wave for them, then calls the composer in `compose` mode.
- **Dispatch budget:** `COMPOSER_MAX_DISPATCHES = 1` in `lib/constants.ts`. Hard cap. The composer's `gap-check` is only consulted once.
- **Telemetry:** log `composer_dispatch` events with count and rationale.

### Files touched

- `src/lib/llm/investigate-composer.ts` — add `mode` parameter, new gap-check system prompt, new parser for the gap-check output.
- `src/lib/pipeline/investigate-orchestrator.ts` — terminal phase calls composer in gap-check mode, optionally dispatches one more wave, then composes.
- `src/lib/constants.ts` — `COMPOSER_MAX_DISPATCHES = 1`.
- `src/lib/__tests__/investigate-composer.test.ts` — gap-check parser, dispatch budget enforcement.

### Acceptance criteria

- [ ] An investigation whose results are missing a key denominator (e.g. asked about churn rates but only counted churns) prompts the composer to request "total active customers per segment" and that runs as a final wave before the spec is composed.
- [ ] An investigation with complete results returns `needs: []` and proceeds directly to compose.
- [ ] Dispatch budget of 1 is enforced — composer is never given a second chance to ask for more.
- [ ] Composer failures (JSON parse, timeout) fall back to direct compose mode with whatever results are available.
- [ ] `npm run type-check` and `npm run lint` pass.

### Risks

- **Composer asks for vague follow-ups.** Mitigation: gap-check prompt explicitly requires each `needs` entry to be answerable by one Python script, reference real columns from the original schema, and not duplicate the rationale of any existing sub-question.
- **Composer-dispatched wave breaks the schema-only privacy posture.** Mitigation: composer-dispatched sub-questions go through `runPipeline()` with `mode: "metadata"` like every other sub-question. No new code path, no new privacy boundary.
- **Loop closure failure.** A buggy gap-check that always returns `needs.length > 0` would be a problem if budget weren't enforced. Mitigation: budget is enforced at the orchestrator level, not at the composer level — a misbehaving composer cannot force a second dispatch.

### Sample test data

- `data/test-fixtures/agentic-tier-1/composer-dispatch/churn-rates.csv` — has churn counts but not population denominators across segments. Asking "Which segment churns most?" produces sub-questions about churn counts; the composer should recognize the gap and request denominators before composing the final dashboard.

---

## Out-of-band acceptance criteria (all items)

When all four items have landed:

- [ ] An end-to-end Investigate run on the `customer-churn.csv` fixture demonstrates: (a) initial plan with at least one DAG dependency (item #1), (b) one degenerate sub-question result detected and retried successfully (item #2), (c) one re-plan amendment after wave 0 (item #3), (d) one composer-dispatched follow-up before final compose (item #4). All visible in the live step-list UI.
- [ ] The investigation completes within `2 × INVESTIGATE_MAX_HOPS + 1 + 1 = 6` waves maximum.
- [ ] Telemetry from a 50-run synthetic eval (mix of CSV + warehouse questions) shows: degenerate-result rate down vs. baseline; investigations classified as "amended" or "stopped early" present at a non-trivial rate (≥10% each); zero runaway investigations.
- [ ] The full Investigate stack remains schema-only — no row values reach the planner, re-planner, or composer in any mode.
- [ ] [`agentic-data-analysis-assessment-2026-05-31.md`](./agentic-data-analysis-assessment-2026-05-31.md) is amended with a "What shipped" appendix referencing this plan and the resulting capability-ladder rating (target: level 4).

---

## Estimated total effort

| Item      | Days           |
| --------- | -------------- |
| #1        | 2–3            |
| #2        | 3–4            |
| #3        | 5–7            |
| #4        | 3–4            |
| **Total** | **13–18 days** |

Roughly 3 weeks of focused work for a working version of all four, plus 1 week of evaluation and prompt-tuning on real investigations before declaring Tier 1 complete.
