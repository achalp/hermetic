/**
 * Catalog sample-coverage RATCHET. The render smoke test loops
 * ALL_CATALOG_SAMPLES, but nothing asserted every catalog component HAS a
 * sample — so adding a component with no sample was silently green (46+ went
 * uncovered this way). This guard makes the coverage set monotonic:
 *
 *  - every catalog component is either sampled OR in KNOWN_UNSAMPLED,
 *  - KNOWN_UNSAMPLED carries no stale names (component removed → drop it),
 *  - KNOWN_UNSAMPLED and the samples are disjoint (added a sample → remove it
 *    from the list; the allowlist only ever shrinks).
 *
 * So: a NEW component must ship a render sample or be consciously allowlisted,
 * and the debt can only go down. Shrink KNOWN_UNSAMPLED as samples are added.
 */
import { describe, it, expect } from "vitest";
import { catalog } from "@/lib/catalog";
import { ALL_CATALOG_SAMPLES } from "@/lib/__tests__/fixtures/catalog-samples";

// Components without a render sample yet (captured 2026-08; only remove, never add).
const KNOWN_UNSAMPLED = new Set<string>([
  "Annotation",
  "BeeswarmChart",
  "BoxPlot",
  "BulletChart",
  "BumpChart",
  "CalendarChart",
  "CandlestickChart",
  "ChartImage",
  "ChordChart",
  "ColorPicker",
  "ConfusionMatrix",
  "DataController",
  "DataTable",
  "DatePicker",
  "DecisionTree",
  "DefinitionList",
  "DumbbellChart",
  "FormController",
  "Globe3D",
  "HeatMap",
  "Histogram",
  "LayoutColumn",
  "LayoutGrid",
  "LayoutRow",
  "Map3D",
  "MapView",
  "MarimekkoChart",
  "MultiSelect",
  "NumberInput",
  "ParallelCoordinates",
  "PivotTable",
  "RadarChart",
  "RangeSlider",
  "RidgelineChart",
  "RocCurve",
  "SankeyChart",
  "Scatter3D",
  "SectionBreak",
  "SelectControl",
  "ShapBeeswarm",
  "Slider",
  "SlopeChart",
  "StreamChart",
  "SunburstChart",
  "Surface3D",
  "TextArea",
  "TextInput",
  "ToggleSwitch",
  "TreemapChart",
  "TrendIndicator",
  "ViolinChart",
  "WaterfallChart",
]);

describe("catalog sample coverage (ratchet)", () => {
  const names = [...(catalog as { componentNames: readonly string[] }).componentNames];
  const sampled = new Set(Object.keys(ALL_CATALOG_SAMPLES));

  it("every catalog component is sampled or explicitly allowlisted (no silent gaps)", () => {
    const uncovered = names.filter((n) => !sampled.has(n) && !KNOWN_UNSAMPLED.has(n));
    expect(uncovered, `add a render sample (or allowlist) for: ${uncovered.join(", ")}`).toEqual(
      []
    );
  });

  it("the allowlist only shrinks: no stale names, none already sampled", () => {
    const stale = [...KNOWN_UNSAMPLED].filter((n) => !names.includes(n));
    expect(stale, `remove components no longer in the catalog: ${stale.join(", ")}`).toEqual([]);
    const nowSampled = [...KNOWN_UNSAMPLED].filter((n) => sampled.has(n));
    expect(
      nowSampled,
      `now sampled — remove from KNOWN_UNSAMPLED: ${nowSampled.join(", ")}`
    ).toEqual([]);
  });
});
