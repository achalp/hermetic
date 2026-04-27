import { describe, it, expect } from "vitest";
import {
  __pivotForTesting as pivot,
  __pivotMultiForTesting as pivotMulti,
  __sortRowKeysForTesting as sortRowKeys,
  __heatmapStyleForTesting as heatmapStyle,
} from "@/components/pivot-table";

const data = [
  { region: "NA", quarter: "Q1", revenue: 100 },
  { region: "NA", quarter: "Q1", revenue: 50 },
  { region: "NA", quarter: "Q2", revenue: 200 },
  { region: "EMEA", quarter: "Q1", revenue: 80 },
  { region: "EMEA", quarter: "Q2", revenue: 120 },
  { region: "APAC", quarter: "Q2", revenue: 90 },
];

describe("pivot — sum", () => {
  it("groups rows × columns and sums values", () => {
    const r = pivot(data, "region", "quarter", "revenue", "sum");
    expect(r.rowKeys).toEqual(["APAC", "EMEA", "NA"]); // sorted
    expect(r.colKeys).toEqual(["Q1", "Q2"]);
    expect(r.cells.get("NA")?.get("Q1")).toBe(150);
    expect(r.cells.get("NA")?.get("Q2")).toBe(200);
    expect(r.cells.get("EMEA")?.get("Q1")).toBe(80);
    expect(r.cells.get("APAC")?.get("Q1")).toBeUndefined();
  });

  it("computes row totals correctly", () => {
    const r = pivot(data, "region", "quarter", "revenue", "sum");
    expect(r.rowTotals.get("NA")).toBe(350);
    expect(r.rowTotals.get("EMEA")).toBe(200);
    expect(r.rowTotals.get("APAC")).toBe(90);
  });

  it("computes column totals correctly", () => {
    const r = pivot(data, "region", "quarter", "revenue", "sum");
    expect(r.colTotals.get("Q1")).toBe(230);
    expect(r.colTotals.get("Q2")).toBe(410);
  });

  it("computes grand total", () => {
    const r = pivot(data, "region", "quarter", "revenue", "sum");
    expect(r.grandTotal).toBe(640);
  });
});

describe("pivot — count", () => {
  it("counts rows regardless of value type", () => {
    const r = pivot(data, "region", "quarter", "revenue", "count");
    expect(r.cells.get("NA")?.get("Q1")).toBe(2);
    expect(r.cells.get("NA")?.get("Q2")).toBe(1);
    expect(r.cells.get("EMEA")?.get("Q1")).toBe(1);
  });

  it("totals count by row + column", () => {
    const r = pivot(data, "region", "quarter", "revenue", "count");
    expect(r.rowTotals.get("NA")).toBe(3);
    expect(r.colTotals.get("Q1")).toBe(3);
    expect(r.grandTotal).toBe(6);
  });
});

describe("pivot — mean", () => {
  it("averages numeric values per cell", () => {
    const r = pivot(data, "region", "quarter", "revenue", "mean");
    // NA/Q1 has [100, 50] → mean = 75
    expect(r.cells.get("NA")?.get("Q1")).toBe(75);
    // NA/Q2 has [200] → mean = 200
    expect(r.cells.get("NA")?.get("Q2")).toBe(200);
  });

  it("computes column mean across all rows in that column (not mean-of-means)", () => {
    const r = pivot(data, "region", "quarter", "revenue", "mean");
    // Q1 has [100, 50, 80] → mean = 76.67
    expect(r.colTotals.get("Q1")).toBeCloseTo(76.6667, 2);
    // Q2 has [200, 120, 90] → mean = 136.67
    expect(r.colTotals.get("Q2")).toBeCloseTo(136.6667, 2);
  });
});

describe("pivot — min / max", () => {
  it("min picks smallest value per cell", () => {
    const r = pivot(data, "region", "quarter", "revenue", "min");
    expect(r.cells.get("NA")?.get("Q1")).toBe(50);
    expect(r.cells.get("EMEA")?.get("Q1")).toBe(80);
  });

  it("max picks largest value per cell", () => {
    const r = pivot(data, "region", "quarter", "revenue", "max");
    expect(r.cells.get("NA")?.get("Q1")).toBe(100);
    expect(r.cells.get("NA")?.get("Q2")).toBe(200);
  });
});

describe("pivot — edge cases", () => {
  it("returns empty result for empty input", () => {
    const r = pivot([], "region", "quarter", "revenue", "sum");
    expect(r.rowKeys).toEqual([]);
    expect(r.colKeys).toEqual([]);
    expect(r.grandTotal).toBe(0);
  });

  it("excludes non-numeric values from sum/mean/min/max", () => {
    const messy = [
      { region: "NA", quarter: "Q1", revenue: 100 },
      { region: "NA", quarter: "Q1", revenue: "n/a" },
      { region: "NA", quarter: "Q1", revenue: null },
    ];
    const r = pivot(messy, "region", "quarter", "revenue", "sum");
    expect(r.cells.get("NA")?.get("Q1")).toBe(100);
  });

  it("treats null/undefined dimension values as empty string keys", () => {
    const messy = [
      { region: null, quarter: "Q1", revenue: 50 },
      { region: "NA", quarter: undefined, revenue: 80 },
    ];
    const r = pivot(messy, "region", "quarter", "revenue", "sum");
    // null region becomes "", undefined quarter becomes "" — both registered
    expect(r.rowKeys).toContain("");
    expect(r.rowKeys).toContain("NA");
    expect(r.colKeys).toContain("");
    expect(r.colKeys).toContain("Q1");
  });

  it("handles 50 rows × 8 cols × 3 measures efficiently", () => {
    const big: Record<string, unknown>[] = [];
    for (let r = 0; r < 50; r++) {
      for (let c = 0; c < 8; c++) {
        big.push({ rk: `row${r}`, ck: `col${c}`, v: r * c, w: r + c, k: r });
      }
    }
    const t0 = performance.now();
    const result = pivotMulti(big, "rk", "ck", [
      { value: "v", aggregator: "sum" },
      { value: "w", aggregator: "mean" },
      { value: "k", aggregator: "count" },
    ]);
    const t1 = performance.now();
    expect(result.rowKeys).toHaveLength(50);
    expect(result.colKeys).toHaveLength(8);
    expect(result.measures).toHaveLength(3);
    // 50×8×3 = 1200 cells should pivot in well under 200ms
    expect(t1 - t0).toBeLessThan(200);
  });

  it("handles 50 rows × 8 cols efficiently (legacy single-measure)", () => {
    const big: Record<string, unknown>[] = [];
    for (let r = 0; r < 50; r++) {
      for (let c = 0; c < 8; c++) {
        big.push({ rk: `row${r}`, ck: `col${c}`, v: r * c });
      }
    }
    const t0 = performance.now();
    const result = pivot(big, "rk", "ck", "v", "sum");
    const t1 = performance.now();
    expect(result.rowKeys).toHaveLength(50);
    expect(result.colKeys).toHaveLength(8);
    expect(t1 - t0).toBeLessThan(100); // 50×8 should pivot in <100ms
  });
});

// ── Multi-measure pivot ────────────────────────────────────────

describe("pivotMulti — multi-value, multi-aggregator", () => {
  const data = [
    { region: "NA", quarter: "Q1", revenue: 100, units: 10 },
    { region: "NA", quarter: "Q1", revenue: 50, units: 5 },
    { region: "NA", quarter: "Q2", revenue: 200, units: 20 },
    { region: "EMEA", quarter: "Q1", revenue: 80, units: 8 },
    { region: "EMEA", quarter: "Q2", revenue: 120, units: 12 },
  ];

  it("computes two measures (sum revenue + sum units)", () => {
    const r = pivotMulti(data, "region", "quarter", [
      { value: "revenue", aggregator: "sum" },
      { value: "units", aggregator: "sum" },
    ]);
    expect(r.rowKeys).toEqual(["EMEA", "NA"]);
    expect(r.colKeys).toEqual(["Q1", "Q2"]);
    expect(r.measures).toHaveLength(2);

    // Revenue measure
    const rev = r.measures[0];
    expect(rev.cells.get("NA")?.get("Q1")).toBe(150);
    expect(rev.cells.get("EMEA")?.get("Q2")).toBe(120);

    // Units measure (independent rectangle, same dims)
    const units = r.measures[1];
    expect(units.cells.get("NA")?.get("Q1")).toBe(15);
    expect(units.cells.get("EMEA")?.get("Q2")).toBe(12);
  });

  it("supports different aggregators per measure (sum + mean + count)", () => {
    const r = pivotMulti(data, "region", "quarter", [
      { value: "revenue", aggregator: "sum" },
      { value: "revenue", aggregator: "mean" },
      { value: "revenue", aggregator: "count" },
    ]);
    expect(r.measures).toHaveLength(3);
    const [sum, mean, count] = r.measures;
    expect(sum.cells.get("NA")?.get("Q1")).toBe(150);
    expect(mean.cells.get("NA")?.get("Q1")).toBe(75);
    expect(count.cells.get("NA")?.get("Q1")).toBe(2);
  });

  it("each measure has its own independent totals", () => {
    const r = pivotMulti(data, "region", "quarter", [
      { value: "revenue", aggregator: "sum" },
      { value: "units", aggregator: "sum" },
    ]);
    const rev = r.measures[0];
    const units = r.measures[1];
    expect(rev.rowTotals.get("NA")).toBe(350);
    expect(units.rowTotals.get("NA")).toBe(35);
    expect(rev.grandTotal).toBe(550);
    expect(units.grandTotal).toBe(55);
  });

  it("union of row/col keys across measures (when measures see different subsets)", () => {
    // measure A is only present for NA; measure B is only present for EMEA
    const sparse = [
      { region: "NA", quarter: "Q1", a: 1 },
      { region: "EMEA", quarter: "Q2", b: 2 },
    ];
    const r = pivotMulti(sparse, "region", "quarter", [
      { value: "a", aggregator: "sum" },
      { value: "b", aggregator: "sum" },
    ]);
    // Both rows + both columns should appear in the union
    expect(r.rowKeys).toEqual(["EMEA", "NA"]);
    expect(r.colKeys).toEqual(["Q1", "Q2"]);
    // Cells exist only where the measure has data
    expect(r.measures[0].cells.get("NA")?.get("Q1")).toBe(1);
    expect(r.measures[0].cells.get("EMEA")?.get("Q2")).toBeUndefined();
    expect(r.measures[1].cells.get("EMEA")?.get("Q2")).toBe(2);
    expect(r.measures[1].cells.get("NA")?.get("Q1")).toBeUndefined();
  });

  it("single-measure call via pivotMulti matches pivot helper output", () => {
    const single = pivot(data, "region", "quarter", "revenue", "sum");
    const multi = pivotMulti(data, "region", "quarter", [{ value: "revenue", aggregator: "sum" }]);
    expect(multi.measures).toHaveLength(1);
    const m = multi.measures[0];
    expect(m.rowKeys).toEqual(single.rowKeys);
    expect(m.colKeys).toEqual(single.colKeys);
    expect(m.cells.get("NA")?.get("Q1")).toBe(single.cells.get("NA")?.get("Q1"));
    expect(m.grandTotal).toBe(single.grandTotal);
  });

  it("returns empty result when no measures provided", () => {
    const r = pivotMulti(data, "region", "quarter", []);
    expect(r.measures).toEqual([]);
    expect(r.rowKeys).toEqual([]);
    expect(r.colKeys).toEqual([]);
  });

  it("count aggregator counts every row regardless of value type", () => {
    const messy = [
      { region: "NA", quarter: "Q1", x: 100 },
      { region: "NA", quarter: "Q1", x: "n/a" },
      { region: "NA", quarter: "Q1", x: null },
    ];
    const r = pivotMulti(messy, "region", "quarter", [
      { value: "x", aggregator: "count" },
      { value: "x", aggregator: "sum" },
    ]);
    // count includes all 3 rows
    expect(r.measures[0].cells.get("NA")?.get("Q1")).toBe(3);
    // sum includes only the numeric one
    expect(r.measures[1].cells.get("NA")?.get("Q1")).toBe(100);
  });
});

// ── Sort: row-key ordering by user click target ───────────────────────

describe("sortRowKeys — rowDim sort", () => {
  const measureResults = pivotMulti(
    [
      { region: "NA", quarter: "Q1", revenue: 100 },
      { region: "EMEA", quarter: "Q1", revenue: 200 },
      { region: "APAC", quarter: "Q1", revenue: 50 },
    ],
    "region",
    "quarter",
    [{ value: "revenue", aggregator: "sum" }]
  ).measures;

  it("ascending sorts row dim alphabetically", () => {
    const r = sortRowKeys(
      ["NA", "EMEA", "APAC"],
      { target: { kind: "rowDim" }, dir: "asc" },
      measureResults
    );
    expect(r).toEqual(["APAC", "EMEA", "NA"]);
  });

  it("descending sorts row dim reverse-alphabetically", () => {
    const r = sortRowKeys(
      ["APAC", "EMEA", "NA"],
      { target: { kind: "rowDim" }, dir: "desc" },
      measureResults
    );
    expect(r).toEqual(["NA", "EMEA", "APAC"]);
  });

  it("null sort returns input order untouched", () => {
    const input = ["NA", "APAC", "EMEA"];
    expect(sortRowKeys(input, null, measureResults)).toEqual(input);
  });
});

describe("sortRowKeys — sort by column value", () => {
  const data = [
    { region: "NA", quarter: "Q1", revenue: 100 },
    { region: "EMEA", quarter: "Q1", revenue: 200 },
    { region: "APAC", quarter: "Q1", revenue: 50 },
  ];
  const measureResults = pivotMulti(data, "region", "quarter", [
    { value: "revenue", aggregator: "sum" },
  ]).measures;

  it("descending picks the largest cell value first", () => {
    const r = sortRowKeys(
      ["APAC", "EMEA", "NA"],
      { target: { kind: "col", colKey: "Q1", measureIdx: 0 }, dir: "desc" },
      measureResults
    );
    expect(r).toEqual(["EMEA", "NA", "APAC"]);
  });

  it("ascending picks the smallest cell value first", () => {
    const r = sortRowKeys(
      ["APAC", "EMEA", "NA"],
      { target: { kind: "col", colKey: "Q1", measureIdx: 0 }, dir: "asc" },
      measureResults
    );
    expect(r).toEqual(["APAC", "NA", "EMEA"]);
  });
});

describe("sortRowKeys — sort by row total", () => {
  const data = [
    { region: "NA", quarter: "Q1", revenue: 100 },
    { region: "NA", quarter: "Q2", revenue: 200 }, // NA total = 300
    { region: "EMEA", quarter: "Q1", revenue: 80 },
    { region: "EMEA", quarter: "Q2", revenue: 120 }, // EMEA total = 200
    { region: "APAC", quarter: "Q1", revenue: 50 }, // APAC total = 50
  ];
  const measureResults = pivotMulti(data, "region", "quarter", [
    { value: "revenue", aggregator: "sum" },
  ]).measures;

  it("descending ranks by row total — largest first", () => {
    const r = sortRowKeys(
      ["APAC", "EMEA", "NA"],
      { target: { kind: "total", measureIdx: 0 }, dir: "desc" },
      measureResults
    );
    expect(r).toEqual(["NA", "EMEA", "APAC"]);
  });
});

// ── Heatmap shading ───────────────────────────────────────────────────

describe("heatmapStyle", () => {
  it("returns empty style for undefined value", () => {
    expect(heatmapStyle(undefined, 0, 100)).toEqual({});
  });

  it("returns empty style when range collapses (max <= min)", () => {
    expect(heatmapStyle(50, 50, 50)).toEqual({});
  });

  it("min value gets the lightest alpha, max gets the strongest", () => {
    const minStyle = heatmapStyle(0, 0, 100);
    const maxStyle = heatmapStyle(100, 0, 100);
    // Both produce backgrounds; the alpha on max should be much larger
    expect(minStyle.background).toMatch(/rgba\(99, 102, 241, 0\.0\d+\)/);
    expect(maxStyle.background).toMatch(/rgba\(99, 102, 241, 0\.4\d*\)/);
  });

  it("clamps values outside [min, max] to the range", () => {
    expect(heatmapStyle(150, 0, 100).background).toBe(heatmapStyle(100, 0, 100).background);
    expect(heatmapStyle(-10, 0, 100).background).toBe(heatmapStyle(0, 0, 100).background);
  });

  it("midpoint produces alpha ~0.225", () => {
    const mid = heatmapStyle(50, 0, 100);
    // 0.05 + 0.5 * 0.35 = 0.225
    expect(mid.background).toContain("0.225");
  });
});

// ── MeasureResult.cellMin / cellMax (used for heatmap shading) ────────

describe("MeasureResult cell min/max", () => {
  it("captures the min and max aggregated cell value", () => {
    const r = pivotMulti(
      [
        { region: "NA", quarter: "Q1", revenue: 100 },
        { region: "NA", quarter: "Q2", revenue: 250 },
        { region: "EMEA", quarter: "Q1", revenue: 25 },
      ],
      "region",
      "quarter",
      [{ value: "revenue", aggregator: "sum" }]
    );
    expect(r.measures[0].cellMin).toBe(25);
    expect(r.measures[0].cellMax).toBe(250);
  });

  it("uses 0 as fallback when no numeric values exist", () => {
    const r = pivotMulti([{ region: "NA", quarter: "Q1", revenue: "n/a" }], "region", "quarter", [
      { value: "revenue", aggregator: "sum" },
    ]);
    expect(r.measures[0].cellMin).toBe(0);
    expect(r.measures[0].cellMax).toBe(0);
  });
});
