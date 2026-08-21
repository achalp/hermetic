/**
 * Chart data transforms (perf P10): extracted pure so the render bodies can
 * memoize them. These pin the exact pre-extraction behavior — dedup/sum,
 * value bounds always spanning 0, single-pass scatter grouping preserving the
 * old filter-per-group ordering, and pie id-dedup with identical suffixing.
 */
import { describe, it, expect } from "vitest";
import { dedupeBarRows, barValueBounds } from "@/components/charts/bar-chart";
import { buildScatterData } from "@/components/charts/scatter-chart";
import { normalizePieData } from "@/components/charts/pie-chart";

describe("dedupeBarRows", () => {
  it("sums numeric y values for duplicate x keys, keeping first-row extras", () => {
    const out = dedupeBarRows(
      [
        { m: "Jan", v: 10, note: "first" },
        { m: "Feb", v: 5 },
        { m: "Jan", v: 7 },
      ],
      "m",
      ["v"]
    );
    expect(out).toEqual([
      { m: "Jan", v: 17, note: "first" },
      { m: "Feb", v: 5 },
    ]);
  });

  it("treats missing/non-numeric values as 0 when summing", () => {
    const out = dedupeBarRows(
      [
        { m: "a", v: "x" },
        { m: "a", v: 3 },
      ],
      "m",
      ["v"]
    );
    expect(out).toEqual([{ m: "a", v: 3 }]);
  });
});

describe("barValueBounds", () => {
  it("always includes 0 (all-positive and all-negative data)", () => {
    expect(barValueBounds([{ v: 5 }, { v: 9 }], ["v"])).toEqual({ min: 0, max: 9 });
    expect(barValueBounds([{ v: -5 }, { v: -9 }], ["v"])).toEqual({ min: -9, max: 0 });
  });

  it("spans multiple y keys; empty data → 0..0", () => {
    expect(barValueBounds([{ a: -2, b: 7 }], ["a", "b"])).toEqual({ min: -2, max: 7 });
    expect(barValueBounds([], ["v"])).toEqual({ min: 0, max: 0 });
  });
});

describe("buildScatterData", () => {
  const rows = [
    { x: 1, y: 2, g: "A" },
    { x: "bad", y: 3, g: "B" }, // invalid x → dropped
    { x: 5, y: 1, g: "B" },
    { x: -3, y: 4, g: "A" },
  ];

  it("extracts valid points, groups in first-appearance order, and bounds in one pass", () => {
    const out = buildScatterData(rows, "x", "y", "g");
    expect(out.points).toHaveLength(3);
    expect(out.groupNames).toEqual(["A", "B"]); // first-appearance order
    expect(out.series).toEqual([
      {
        id: "A",
        data: [
          { x: 1, y: 2 },
          { x: -3, y: 4 },
        ],
      },
      { id: "B", data: [{ x: 5, y: 1 }] },
    ]);
    expect(out.minX).toBe(-3);
    expect(out.maxX).toBe(5);
  });

  it("no group key → a single 'default' series; empty/invalid input → empty with 0 bounds", () => {
    const out = buildScatterData(rows, "x", "y", null);
    expect(out.groupNames).toEqual(["default"]);
    expect(out.series[0].data).toHaveLength(3);
    const empty = buildScatterData([{ x: "n/a", y: "n/a" }], "x", "y", null);
    expect(empty.points).toEqual([]);
    expect(empty.minX).toBe(0);
    expect(empty.maxX).toBe(0);
  });
});

describe("normalizePieData", () => {
  it("uses label/value keys, rounds to 2dp, and suffixes duplicate ids identically to the old O(n²) dedup", () => {
    const out = normalizePieData([
      { label: "a", value: 1.005 },
      { label: "b", value: 2 },
      { label: "a", value: 3 },
      { label: "a", value: 4 },
    ]);
    expect(out).toEqual([
      { id: "a", value: 1.0 },
      { id: "b", value: 2 },
      { id: "a (2)", value: 3 },
      { id: "a (3)", value: 4 },
    ]);
  });

  it("infers label/value from the first string-ish and number-ish fields; drops unusable rows", () => {
    const out = normalizePieData([{ region: "West", revenue: 10.129 }, { junk: null }]);
    expect(out).toEqual([{ id: "West", value: 10.13 }]);
  });
});
