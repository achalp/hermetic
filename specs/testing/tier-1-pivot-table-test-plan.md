# Test Plan — Pivot Table (Tier 1, Item #4)

_Last updated: 2026-04-25_

**Spec:** [`tier-1-implementation-plan-2026-04-25.md`](../tier-1-implementation-plan-2026-04-25.md) §"Item #4"

---

## What this feature does

Adds a `PivotTable` component for two-dimensional crosstab views (e.g. "revenue by region by quarter"). The LLM provides long-format rows; the component pivots client-side into rowDim × colDim × value cells. Supports row + column totals and 5 aggregators: sum, count, mean, min, max.

**v1 (initial):** single value column, single aggregator, optional totals.
**v2 (2026-04-25):** **multi-value, multi-aggregator** — provide `measures: [{value, aggregator, label?, format?, precision?}, ...]` to render multiple sub-columns under each colDim header. Single-measure API (`value` + `aggregator`) remains supported for backwards compatibility.

Still deferred: subtotals at intermediate levels, drill-into-cell, conditional formatting per cell, sort-by-total.

---

## Files changed

- `src/components/pivot-table.tsx` — **new** (~350 LOC including pivot logic, formatting, sticky columns, exports)
- `src/lib/catalog.ts` — `PivotTable` registered with description guiding the LLM on when to pick it
- `src/components/registry.tsx` — wired into the JSON-Render registry
- `src/lib/__tests__/pivot-table.test.ts` — **14 unit tests**

---

## Automated tests

```bash
npx vitest run src/lib/__tests__/pivot-table.test.ts
```

Expect: **14 passed**. Coverage:

- **Sum:** cell aggregation, row totals, column totals, grand total
- **Count:** non-numeric values still count, totals
- **Mean:** per-cell mean, column-mean across all rows (not mean-of-means)
- **Min / max:** correct value selection
- **Edge cases:** empty input, non-numeric values excluded from sum/mean/min/max, null/undefined dimensions become `""` keys, 50×8 pivot completes in <100ms

```bash
npm run type-check
```

Expect: clean.

---

## Manual smoke test

### Setup

1. Start dev server: `npm run dev`
2. Upload `data/test-fixtures/tier-1/pivot-table/sales-by-region-quarter.csv` (60 rows: 5 regions × 4 quarters × 3 years)

### Test 1 — Direct LLM request

Ask: _"Show me revenue by region by quarter as a pivot table, with row and column totals"_

**Pass:**

- A `PivotTable` renders with regions on the left axis (alphabetical), quarters on the top (Q1, Q2, Q3, Q4)
- Cells show summed revenue across all 3 years
- Bottom row shows column totals; right column shows row totals; corner shows grand total
- Cell values are formatted (e.g. `$1,234,567` if currency hint, otherwise `1,234,567`)
- Two export buttons (CSV, XLSX) work

### Test 2 — Aggregator switch

Ask: _"Now show me the average discount rate by region by quarter as a pivot, no totals"_

**Pass:** values are means in 0–1 range, no totals row/column.

### Test 3 — Count aggregator

Ask: _"Count of orders by category by status as a pivot"_ (using a CSV with category + status columns)

**Pass:** cells show integer counts, totals if requested.

### Test 4 — Wide pivot horizontal scroll

Pivot with 12 column dimensions (e.g. "revenue by region by month").

**Pass:** the table scrolls horizontally; the row-dimension (left) column stays sticky.

### Test 5 — Empty / no-match

Ask a pivot whose dimensions don't intersect (e.g. wrong column names). The component renders a "no data" message instead of crashing.

### Test 6 — Export round-trip

Click Export XLSX. Open in Excel.

**Pass:** the pivot shape is preserved (rowDim header, columns, totals row/column if present).

---

## API contract

```ts
PivotTable: {
  rows: Array<Record<string, unknown>>;     // long-format
  rowDim: string;                           // column to use for left axis
  colDim: string;                           // column to use for top axis
  value: string;                            // column to aggregate
  aggregator?: "sum" | "count" | "mean" | "min" | "max";  // default "sum"
  showRowTotals?: boolean;
  showColTotals?: boolean;
  caption?: string;
  valueFormat?: "currency" | "percent" | "number";
  precision?: number;
}
```

---

## Known limitations / non-goals

- **Single value column** in v1. Multi-value pivots (revenue + units side-by-side) require a v2 wrapper.
- **No subtotals at intermediate levels.** Only the final row/column totals.
- **No drill-into-cell.** Clicking a cell does nothing in v1.
- **No conditional cell formatting** (heatmap-style coloring). Add later if desired.
- **Sorting:** rows and columns are alphabetically sorted. No "sort by total descending" in v1.
- **Headers must be strings.** Numeric column dimensions get string-coerced.
- **Performance:** in-memory pivot in JS — fine for a few thousand cells (50 rows × 50 cols = 2500 cells, sub-100ms). For larger pivots, the LLM should pre-aggregate in Python before sending the spec.

---

## Sample fixture

`data/test-fixtures/tier-1/pivot-table/sales-by-region-quarter.csv` — 60 rows × 6 columns:

| Column          | Type                                             |
| --------------- | ------------------------------------------------ |
| `region`        | string (5 distinct: NA, EMEA, APAC, LATAM, MENA) |
| `quarter`       | string (Q1–Q4)                                   |
| `year`          | number (2022, 2023, 2024)                        |
| `revenue`       | number                                           |
| `units`         | number                                           |
| `discount_rate` | number (0.0–0.2)                                 |

Designed to surface meaningful 2-D crosstabs:

- region × quarter (5 × 4)
- region × year (5 × 3)
- year × quarter (3 × 4)
- All three with sum, mean, count

---

## Rollback

Delete:

- `src/components/pivot-table.tsx`
- `src/lib/__tests__/pivot-table.test.ts`

Revert:

- `src/lib/catalog.ts` (remove `PivotTable` entry)
- `src/components/registry.tsx` (remove import + registry entry)

No other side effects — the component is purely additive.
