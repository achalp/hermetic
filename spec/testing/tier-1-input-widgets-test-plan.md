# Test Plan — More Input Widgets (Tier 1, Item #7)

_Last updated: 2026-04-25_

**Spec:** [`tier-1-implementation-plan-2026-04-25.md`](../tier-1-implementation-plan-2026-04-25.md) §"Item #7"

---

## What this feature does

Adds five new input components: `DatePicker`, `Slider`, `RangeSlider`, `ColorPicker`, `MultiSelect`. The LLM can now compose interactive dashboards with date filters, threshold sliders, range sliders, color pickers, and chip-style multi-select filters.

The DataController automatically handles the new value shapes:

- **MultiSelect** → `string[]` → membership filter (keeps rows where the column value is in the selected set)
- **RangeSlider** → `[number, number]` → numeric range filter (inclusive)
- **DatePicker / Slider / ColorPicker** → scalar (string or number) → exact match

---

## Files changed

- `src/components/inputs/date-picker.tsx` — **new** (~36 LOC, native `<input type="date">`)
- `src/components/inputs/slider.tsx` — **new** (~50 LOC, native `<input type="range">` with formatted display)
- `src/components/inputs/color-picker.tsx` — **new** (~32 LOC, native `<input type="color">`)
- `src/components/inputs/multi-select.tsx` — **new** (~180 LOC, custom chip-style with type-ahead search and outside-click close)
- `src/components/inputs/range-slider.tsx` — **new** (~140 LOC, two-thumb range built from layered native ranges)
- `src/lib/catalog.ts` — registered `DatePicker`, `Slider`, `RangeSlider`, `ColorPicker`, `MultiSelect` with descriptions
- `src/components/registry.tsx` — wired the five components into the JSON-Render registry
- `src/lib/pipeline/client-pipeline.ts` — `applyFilter` and the structured-data filter helpers (`filterGeoJSON`, `filterGlobeData`, `filterSankeyData`) extended with `rowMatchesFilterValue` to handle `string[]` (multi-select) and `[number, number]` (range) shapes
- `src/lib/__tests__/input-widget-filters.test.ts` — **13 unit tests**

---

## Automated tests

```bash
npx vitest run src/lib/__tests__/input-widget-filters.test.ts
```

Expect: **13 passed**. Coverage:

- Backwards compatibility for scalar filters (string, null, undefined, "", "All")
- MultiSelect: membership match, empty array = all, single-element behavior, numeric/string heterogeneity
- RangeSlider: inclusive bounds, both endpoints, non-numeric exclusion, `[n, n]` exact match, distinguishes `[number, number]` from string-array
- Composite: AND-combination of multi-select + range, multi-select + scalar select

```bash
npm run type-check
```

Expect: clean.

---

## Manual smoke test

### Setup

1. Start dev server: `npm run dev`
2. Upload `data/test-fixtures/tier-1/input-widgets/orders-with-tags.csv` (200 rows of orders with date, region, priority, category, tags, color, price columns)

### Test 1 — DatePicker filter

Ask: _"Show order count by category, with a date-range filter"_

The LLM should compose a dashboard with two `DatePicker` components (start + end) and a category bar chart. Changing dates should re-filter the chart in <100ms.

### Test 2 — MultiSelect filter

Ask: _"Show me revenue by category, filterable by region — let me pick multiple regions"_

The LLM should compose a `MultiSelect` for regions with all 5 regions as options. Selecting two should narrow the chart to those regions only. Selecting none = all regions.

### Test 3 — RangeSlider for price

Ask: _"How does category breakdown change for different price ranges? Let me filter by price"_

The LLM should compose a `RangeSlider` with min ≈ 15 and max ≈ 950 (the actual data bounds). Dragging the thumbs should re-filter the chart inclusively.

### Test 4 — Slider for priority threshold

Ask: _"Filter to orders with priority above N — let me pick N"_

The LLM should compose a `Slider` with min=1, max=5, step=1. Adjusting it should narrow the data.

### Test 5 — ColorPicker (theming)

Ask: _"Let me pick a color for the bar chart"_

The LLM should compose a `ColorPicker` and use the bound value to drive a chart's `color_map`. (This is a niche use case — the LLM may not always pick this; that's fine for v1.)

### Test 6 — Composite scenario

Ask: _"Build me an explorer for these orders: filter by date range, region (multi), price range, and minimum priority — show category breakdown and weekly trend"_

**Pass:** all four filter widgets render, all combine via DataController to filter both charts, performance stays sub-100ms on the 200-row dataset.

---

## Notes on LLM prompt training

The catalog descriptions explicitly tell the model:

- **MultiSelect** is preferred over multiple SelectControls when filtering on a single column with many options
- **RangeSlider** value is `[low, high]`; bind to `/filters/<column>` for automatic range filtering
- **DatePicker** value is an ISO date string

If the model picks the wrong widget (e.g. uses scalar SelectControl when MultiSelect would be better), tighten the prompt examples in `purpose-prompts.ts` or `prompts.ts`.

---

## Known limitations / non-goals

- **MultiSelect** options must be enumerated by the LLM at compose time; no async loading of options from large datasets in v1.
- **RangeSlider** has fixed bounds (LLM picks `min` / `max`); no auto-fit-to-data.
- **DatePicker** uses native HTML date input — calendar UI varies by browser. No bundled calendar library.
- **ColorPicker** uses native HTML color input — same browser-variance caveat.
- **No date-range component** for "from–to" pairs; the LLM uses two `DatePicker`s with `bindTo` paths `/filters/date_min` and `/filters/date_max` and a custom DataController filter expression. (A dedicated `DateRange` component is a future tightening.)

---

## Sample fixture

`data/test-fixtures/tier-1/input-widgets/orders-with-tags.csv` — 200 rows × 7 columns:

| Column           | Type   | Cardinality / Range                      |
| ---------------- | ------ | ---------------------------------------- |
| `order_date`     | date   | 2024-01-01 → 2024-12-31                  |
| `region`         | string | 5 distinct (NA, EMEA, APAC, LATAM, MENA) |
| `priority`       | number | 1–5                                      |
| `category`       | string | 5 distinct                               |
| `tags`           | string | pipe-delimited multi-value               |
| `category_color` | string | 5 distinct hex codes                     |
| `price`          | number | ~$15 – ~$950                             |

Designed to exercise every widget meaningfully.

---

## Rollback

Delete:

- `src/components/inputs/date-picker.tsx`
- `src/components/inputs/slider.tsx`
- `src/components/inputs/color-picker.tsx`
- `src/components/inputs/multi-select.tsx`
- `src/components/inputs/range-slider.tsx`

Revert:

- `src/lib/catalog.ts` (remove the 5 new entries)
- `src/components/registry.tsx` (remove the 5 imports + registry entries)
- `src/lib/pipeline/client-pipeline.ts` (remove `rowMatchesFilterValue` and revert the 4 callers to scalar comparison)

The `applyFilter` change is backwards-compatible — all existing scalar-filter tests pass unchanged. Reverting just removes the multi-select / range capabilities.
