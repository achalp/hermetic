# Privacy: Prevent Real Data from Reaching LLM in UI Composition (Metadata Mode)

## Context

The UI composition LLM call currently receives real data values — aggregation results (up to 30KB), 2 real sample rows per chart_data array, and 8 real distinct values per filterable column. This is fine in sample mode (user explicitly opted in), but in metadata mode (default) no real values should reach the LLM.

The app already has an established placeholder pattern: `$chartData:<key>` and `IMAGE_PLACEHOLDER_<key>` are replaced with real data in the stream after the LLM responds. We extend this pattern to execution results.

## Design

### Mode behavior

| Data                           | metadata mode (default)                                                                          | sample mode                |
| ------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------- |
| results (StatCard values etc.) | Send keys + types only. LLM uses `$result:<key>` placeholders. Stream replaces with real values. | Send real values as today  |
| chartDataShape sample rows     | Omit the 2 sample rows. Send column names, types, row count only.                                | Keep 2 real sample rows    |
| Filterable column samples      | Omit the 8 distinct values. Send column name + distinct count only.                              | Keep real values           |
| TextBlock narratives           | LLM writes qualitative text (no specific numbers)                                                | LLM can embed real numbers |

### `$result:<key>` placeholder pattern

The LLM emits:

```json
{ "type": "StatCard", "props": { "label": "Total Sales", "value": "$result:total_sales" } }
```

The stream processor replaces `"$result:total_sales"` with the real value (e.g., `500000`). Supports dot-notation for nested keys: `"$result:summary.avg_price"`.

### Results schema (what the LLM sees instead of real values)

```json
{
  "total_sales": { "type": "number", "is_integer": true },
  "avg_price": { "type": "number", "is_integer": false },
  "top_category": { "type": "string" }
}
```

Just enough for the LLM to choose the right component and placeholder key.

## File to Change

All changes are in one file: `src/app/api/query/route.ts`

## Implementation Steps

### 1. Add `describeResultsSchema()` helper

After the existing `describeShape()` function. Maps each result key to its type:

```typescript
function describeResultsSchema(results: Record<string, unknown>): Record<string, unknown> {
  // For each key: { type: "number"|"string"|"boolean"|"array"|"object", ... }
  // Numbers get is_integer flag
  // Arrays get length + element_type
  // Objects recurse
}
```

### 2. Modify `describeShape()` to accept `includeSamples` parameter

- Add `includeSamples: boolean` param
- Only include `val.slice(0, 2)` sample rows when `includeSamples` is true
- Call site: `describeShape(v, schemaMode === "sample")`

### 3. Branch the `userPrompt` by mode

**metadata mode:**

- `## Analysis Results Schema` — output of `describeResultsSchema()` (keys + types, no values)
- Instruction: use `$result:<key>` placeholders for StatCard/TrendIndicator values
- Instruction: TextBlock content must be qualitative, no specific numbers

**sample mode:**

- `## Analysis Results` — real `compactResults` as today (no change)

### 4. Modify filterable column descriptions

**metadata mode:** `"region (5 distinct), category (3 distinct)"` — no sample values

**sample mode:** `"region [North, South, East, West, Central]; category [A, B, C]"` — as today

### 5. Add metadata-mode custom rules

Append to the `customRules` array when `schemaMode === "metadata"`:

- Use `$result:<key>` for all scalar values — never fabricate numbers
- TextBlock must be qualitative
- Never hallucinate specific numeric values

### 6. Add `$result:` replacement in stream processor

After the existing `$chartData:` replacement block. Single regex pass:

```typescript
const resultRegex = /"\$result:([a-zA-Z0-9_.]+)"/g;
processed = processed.replace(resultRegex, (_match, keyPath) => {
  // Walk dot-separated path into executionResult.results
  // Return JSON.stringify(value) or leave placeholder if key not found
});
```

## What Does NOT Change

- Code generation step — already handles metadata/sample correctly
- `$chartData:` replacement — unchanged
- `IMAGE_PLACEHOLDER_` replacement — unchanged
- Dataset injection into `/state` — unchanged
- Component registry — `formatStatValue()` already handles numbers and strings
- Catalog schemas — StatCard value is `z.unknown()`, accepts both placeholders and values

## Verification

1. `npx tsc --noEmit` — types pass
2. `npx vitest run` — all tests pass
3. **metadata mode test:** Upload CSV, ask a question. Verify StatCards show real values (from stream replacement), TextBlocks are qualitative, no real values in the LLM prompt
4. **sample mode test:** Same flow. Verify behavior is identical to today
5. **Edge case:** `$result:nonexistent_key` passes through as string (graceful degradation)
