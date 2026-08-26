# Test Plan — Follow-up Question Suggestions (Tier 1, Item #3)

_Last updated: 2026-04-25_

**Spec:** [`tier-1-implementation-plan-2026-04-25.md`](../tier-1-implementation-plan-2026-04-25.md) §"Item #3"

---

## What this feature does

After every successful analysis, surface 3 LLM-generated follow-up questions that take the prior result as a premise and probe deeper. Click a chip → run a new analysis using the same data source.

---

## Files changed in this slice

- `src/app/api/suggest/route.ts` — extended with `mode: "follow-up"`
- `src/lib/api.ts` — added `getSuggestions()`, `getFollowUpSuggestions()`, request types
- `src/lib/suggest-questions.ts` — added `summarizeAnalysisResults()`
- `src/lib/spec-summary.ts` — added `extractSpecComponentTypes()`
- `src/components/app/suggestion-pills.tsx` — added `title` and `layout` props
- `src/app/page.tsx` — wired follow-up fetch + render below dashboard
- `src/lib/__tests__/follow-up-suggestions.test.ts` — unit tests for helpers

## Automated tests

```bash
npx vitest run src/lib/__tests__/follow-up-suggestions.test.ts
```

Expect: **11 passed** (covers `summarizeAnalysisResults` and `extractSpecComponentTypes`).

```bash
npm run type-check
npm run lint
```

Expect: type-check clean, no new lint errors (24 pre-existing warnings remain).

---

## Manual smoke test

### Setup

1. Start dev server: `npm run dev`
2. Open http://localhost:3000
3. Configure any LLM provider (Anthropic key in `.env.local`, or local Ollama from Settings)

### Test 1 — CSV happy path

1. Click **Try sample data** (or upload `data/test-fixtures/tier-1/follow-up-suggestions/sales-2024.csv`)
2. Wait for the LLM-suggested questions on the home screen
3. Click a question, e.g. **"Which product categories drove the strongest growth?"**
4. After the dashboard renders, scroll to the bottom

**Pass:**

- A "Try next" heading appears within ~3s after the dashboard finishes streaming
- 3 follow-up chips are shown
- The chips reference real columns from the CSV (e.g. `region`, `quarter`, `product_category`)
- None of the chips just rephrase the original question
- Clicking a chip kicks off a new analysis without errors

**Fail conditions:**

- Chips never appear (check browser network tab for `/api/suggest` 5xx, check server log)
- Chips appear but rephrase the original question (prompt-quality issue — check the system prompt in `route.ts`)
- Chips appear before the dashboard finishes (race condition with `pageArtifacts.artifacts`)

### Test 2 — Source change clears follow-ups

1. After Test 1, click the logo to reset, upload a different CSV
2. Run a new analysis on the new data

**Pass:** old follow-ups disappear when the source changes; new follow-ups are scoped to the new schema.

### Test 3 — Failed analysis: no follow-ups

1. Force a failure (e.g. ask a question that needs a column the CSV doesn't have, with an unhelpful LLM)
2. Wait for the error toast / retry banner

**Pass:** no follow-up chips appear (effect short-circuits on missing `loadedSpec` / `pageArtifacts.artifacts`).

### Test 4 — Warehouse path

1. Connect to any warehouse (e.g. ClickHouse playground per README)
2. Ask a question that returns rows
3. Wait for dashboard

**Pass:** follow-ups reference table names and column names from the warehouse schema.

### Test 5 — Streaming doesn't double-fetch

1. Run an analysis
2. Open browser network tab
3. Watch `/api/suggest` requests

**Pass:** exactly one follow-up `/api/suggest` request fires per successful analysis (verified by the `followUpKey` dedup).

---

## API contract

### Request

```http
POST /api/suggest
Content-Type: application/json

{
  "mode": "follow-up",
  "schema": { ...CSVSchema },          // OR
  "warehouseSchema": [ ...tables ],
  "question": "What were total sales by region in 2024?",
  "resultsSummary": {
    "total_revenue": "1234567",
    "top_region": "EMEA",
    ...
  },
  "specSummary": ["LayoutGrid", "StatCard", "BarChart", "DataTable"]
}
```

### Response

```json
{ "questions": ["...", "...", "..."] }
```

3 strings, each 10–140 chars, dedup'd against the original question (case-insensitive).

### Error response

```json
{ "error": "..." }
```

with HTTP 4xx/5xx. The client silently swallows errors — follow-ups are a side-channel.

---

## Known limitations / non-goals

- **Quality is LLM-dependent.** Haiku is the default for cost; you can swap to Sonnet in `route.ts` if quality is poor.
- **No caching.** Follow-ups are regenerated on every successful analysis. Could add per-`(question + resultsHash)` caching later.
- **Schema-mode unchanged.** The home-screen suggestions still use Sonnet — only follow-ups use Haiku.
- **Failed analyses skipped.** No follow-ups when the analysis errored out — by design.

---

## Sample test data

`data/test-fixtures/tier-1/follow-up-suggestions/sales-2024.csv` — small synthetic dataset (12 months × 4 product categories × 5 regions) designed to surface meaningful follow-ups around growth, regional performance, and category breakdowns.

---

## Rollback

Revert these files:

- `src/app/api/suggest/route.ts`
- `src/lib/api.ts`
- `src/lib/suggest-questions.ts`
- `src/lib/spec-summary.ts`
- `src/components/app/suggestion-pills.tsx`
- `src/app/page.tsx`

Schema-mode suggestions continue to work because the `mode` parameter defaults to `"schema"`.
