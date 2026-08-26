# Test Plan — Composer-Dispatched Follow-ups (Agentic Tier 1, Item #4)

_Last updated: 2026-05-31_

**Spec:** [`agentic-tier-1-implementation-plan-2026-05-31.md`](../agentic-tier-1-implementation-plan-2026-05-31.md) §"Item #4 — Composer-dispatched follow-ups"

---

## What this feature does

After the wave loop (with its inter-wave re-planning from item #3) terminates, the orchestrator gives the composer ONE chance to inspect the completed sub-question artifacts and request a small number of additional sub-questions before producing the final dashboard. This closes the agentic loop on the composer side — between-wave re-planning catches "I need to drill further" decisions; gap-check catches "I need one more data point to write a coherent dashboard."

Flow:

1. Re-planning loop terminates (no pending sub-questions, or `stop`, or budget exhausted).
2. If `COMPOSER_MAX_DISPATCHES > 0` and at least one sub-question succeeded:
   1. Orchestrator calls `gapCheckComposer()` — a non-streaming LLM call that returns `{ needs: PlannedSubQuestion[], rationale: string }`.
   2. If `needs.length === 0`: proceed to compose.
   3. If `needs.length > 0`: append the new sub-questions to the plan (subject to `INVESTIGATE_MAX_SUBQUESTIONS`), run them as one final wave, then proceed to compose.
3. The compose step itself runs as before (item #3's streaming `composeInvestigation`).

Bounded by `COMPOSER_MAX_DISPATCHES = 1` — gap-check is called at most once per investigation. Composer dispatch is **terminal**: even if gap-check would keep requesting needs, we only dispatch once.

Falls back to `{ needs: [] }` on any LLM or parse failure so the investigation always reaches the compose step.

---

## Files changed

- `src/lib/llm/investigate-composer.ts`:
  - New `GapCheckResult` type, `GAP_CHECK_SYSTEM_PROMPT`, `buildGapCheckUserPrompt()`, `parseGapCheckOutput()` helper.
  - New `gapCheckComposer(args: ComposeArgs): Promise<GapCheckResult>` async function.
  - `__testing` seam exposes `parseGapCheckOutput`.
  - Imports `generateText` from `ai` (was only `streamText`).
- `src/lib/pipeline/investigate-orchestrator.ts`:
  - Imports `gapCheckComposer` and `COMPOSER_MAX_DISPATCHES`.
  - New progress event kind: `composer_dispatched` with `composerRationale` field.
  - New phase after the wave loop: if budget allows and at least one sub-question completed, call gap-check. If `needs.length > 0`, dispatch them via the existing `applyAmendment()` machinery (so caps and bookkeeping are identical to a re-planner amendment) and run one final wave with the dispatched sub-questions.
  - Composer dispatch is one-shot — no re-call after the dispatched wave.
- `src/app/api/query/investigate/route.ts`:
  - Forwards `composer_dispatched` events to the client at `/state/__plan/composerDispatch`.
- `src/lib/llm/__tests__/investigate-composer.test.ts` — **new**: 9 unit tests for `parseGapCheckOutput` covering legal inputs, malformed JSON, missing `needs`, depends_on normalization (scalar + array + out-of-range), the 2-sub-question cap, the 3-deps cap, and markdown-fenced output.
- `src/lib/pipeline/__tests__/investigate-orchestrator.test.ts`:
  - Added `vi.mock` for `@/lib/llm/investigate-composer` so existing tests continue to pass with a no-op default.
  - New 7-test block `runInvestigation — composer-dispatched follow-ups (item #4)` covering: gap-check called after the loop, skipped when nothing completed, dispatched follow-ups added and executed, progress event emitted, one-shot dispatch (no re-call), `INVESTIGATE_MAX_SUBQUESTIONS` cap respected, degraded propagation through the dispatched sub-question.

---

## Automated tests

```bash
npx vitest run src/lib/llm/__tests__/investigate-composer.test.ts src/lib/pipeline/__tests__/investigate-orchestrator.test.ts
```

Expect: **40 passed** (9 composer parser + 31 orchestrator).

**Composer parser — `parseGapCheckOutput`** (9 new tests):

- Happy path `{ needs: [], rationale: "..." }` → `{ needs: [], ... }`.
- Up to 2 valid sub-questions parsed; 3rd dropped.
- Out-of-range `depends_on` indices filtered against the existing step count.
- Legacy scalar `depends_on` number wrapped in array.
- Too-short questions dropped.
- Malformed JSON → safe fallback (no crash).
- Missing `needs` key → safe fallback.
- Markdown-fenced output handled.
- `depends_on` dedupe + 3-cap.

**Orchestrator — `runInvestigation — composer-dispatched follow-ups`** (7 new tests):

- `gapCheckComposer` called once after the main wave loop terminates.
- Skipped when no sub-questions completed successfully (all-failed case).
- `needs.length > 0` results in the new sub-questions running as a final wave.
- `composer_dispatched` progress event emitted with the rationale.
- Gap-check is one-shot — never called again after the dispatched wave.
- `INVESTIGATE_MAX_SUBQUESTIONS = 10` cap respected even on composer dispatch.
- Degraded flag propagates through the dispatched sub-question's result.

```bash
npm run type-check
```

Expect: clean.

```bash
npm test
```

Expect: **432 passed** (was 416 before #4; +9 composer + +7 orchestrator).

```bash
npm run lint
```

Expect: no errors (25 pre-existing warnings unrelated to this change).

---

## Manual smoke test

### Setup

1. Start the dev server: `npm run dev`.
2. Open http://localhost:3000.

### Test 1 — gap-check requests a missing denominator

1. Upload `data/test-fixtures/agentic-tier-1/composer-dispatch/churn-rates.csv`.
   This dataset has churn **counts** by segment but no `active_customers` / population column — so rate calculations are impossible without an external denominator. (Compare to the item #3 fixture `customer-churn.csv`, which has both columns.)
2. Ask via **Investigate** (not single-shot Ask):

   > Which customer segment has the highest churn rate?

3. Expected behavior:
   - The planner decomposes into ~3-5 sub-questions covering churn count by segment, trend, etc.
   - The wave loop completes with all churn counts computed.
   - **Gap-check fires**: the composer sees churn counts but no denominators, and requests a follow-up like:
     - "Compute or estimate total active customers per segment so we can convert counts to rates."
   - **However**: the LLM might recognize from the schema that there's no `active_customers` column at all, and either:
     - Return `needs: []` and proceed to compose with just counts (most likely if it doesn't know how to fabricate a denominator), OR
     - Request a follow-up that the sub-question pipeline can't actually answer (gracefully degraded result).

   This test is **a probe**, not a deterministic assertion. The point is to confirm gap-check is **called** and that its decision (whether `needs: []` or `needs: [...]`) is visible in the server logs and surfaced to the UI.

   Server log lines to look for:

   ```
   [INFO] Investigate: gap-check { stepCount: N, successful: M }
   [INFO] Investigate: gap-check decision { needsCount: 0 or 1, rationale: '...' }
   ```

   If `needsCount > 0`, you'll also see:

   ```
   [INFO] Investigate: plan amended { added: 1, removed: 0, ... }
   ```

4. Confirm a healthy investigation (no gap) on the item #3 fixture `customer-churn.csv` produces `needsCount: 0` — the population column is there, so no gap.

### Test 2 — one-shot dispatch is enforced

Use any dataset and inspect server logs. Regardless of what gap-check returns, you should see at most **one** "gap-check decision" log line per investigation. If you don't see it at all on a successful investigation, that means `completed.size === 0` (all sub-questions failed) — that's the intentional skip case.

### Test 3 — gap-check budget enforcement against the sub-question cap

This is harder to trigger manually since most plans don't hit 10 sub-questions. The unit test "respects INVESTIGATE_MAX_SUBQUESTIONS when applying composer dispatch" covers it.

---

## Sample test data

`data/test-fixtures/agentic-tier-1/composer-dispatch/churn-rates.csv` — 48 rows. 12 months × 4 segments (Enterprise / Mid-Market / SMB / Self-Serve) with **only** `churn_count` (no `active_customers` column). Designed so a rate-based question surfaces the gap; the composer may or may not request a follow-up depending on how the LLM interprets the schema.

---

## Risks observed during implementation

- **Gap-check cost.** One additional non-streaming LLM call per investigation. At Sonnet pricing with the small JSON output (capped at 2K tokens), roughly half a cent per investigation. Not cached — investigations are inherently varied.
- **Composer-dispatched follow-ups bypass the re-planner.** Intentional: gap-check fires AFTER the re-planning loop has exhausted its budget, so we don't want another between-wave re-plan after the dispatched wave. The dispatch is terminal. Tested.
- **One-shot dispatch limits.** A composer that keeps requesting more would be problematic without the cap. `COMPOSER_MAX_DISPATCHES = 1` enforces that gap-check is consulted exactly once. The constant exists so future iterations could raise the cap (probably to 2) if telemetry shows real value.
- **Privacy posture preserved.** Gap-check sees `perStepMetadata` which is the same schema-only view the composer's main prompt uses (result-key types and chart-data shapes). No row values flow into the gap-check prompt.
- **Failure modes.** `gapCheckComposer` falls back to `{ needs: [] }` on LLM error or parse failure. This is consistent with the re-planner's "forward progress > correctness" posture from item #3.
- **Schema-only depends_on validation.** Gap-check sub-questions can depend on the EXISTING completed sub-questions (indices 0..N-1), not on each other. This is a deliberate simplification — the dispatched wave is one batch, and cross-references within that batch would require another mini-DAG layer.

---

## Out of scope

- Tier 2 multi-tool use.
- Cross-investigation memory.
- Hypothesis-driven mode.
- Open-ended exploration.
- Drill-as-sub-investigation for follow-up questions.
- Re-calling gap-check after the dispatched wave (deliberate one-shot).
- Visible UI treatment for `composer_dispatched` events (the SSE patch lands at `/state/__plan/composerDispatch`; the UI can render this in a small follow-up ticket).

---

## What landed across all four items

Hermetic now has the four Tier 1 ingredients defined in the assessment doc:

- **Item #1** — DAG dependencies (`depends_on: number[]`).
- **Item #2** — Semantic result validation (validator detects degenerate results, retries against the same budget, returns `degraded: true` on exhaustion).
- **Item #3** — Re-planning loop between waves (planner re-consulted with completed results; can amend or stop; bounded by `MAX_HOPS` and `MAX_SUBQUESTIONS`).
- **Item #4** — Composer-dispatched follow-ups (gap-check before final compose; one-shot terminal dispatch).

Combined: Investigate is now an agentic loop at level 4 on the capability ladder (planning + DAG + reflection loop + semantic self-debugging). The remaining tier on the ladder before level 5 ("multi-tool use") is the Tier 2 scope from the assessment doc.

End-to-end acceptance against the four items' joint criteria can be validated by running the manual smoke tests in each individual test plan against the corresponding fixture.
