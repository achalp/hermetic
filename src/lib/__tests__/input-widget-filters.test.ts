/**
 * Tests for the new filter shapes introduced by the input-widgets feature:
 * MultiSelect (string[]) and RangeSlider ([low, high]). Existing scalar
 * SelectControl + ToggleSwitch + NumberInput filters are tested implicitly
 * by ensuring backwards-compatibility on those code paths.
 */

import { describe, it, expect } from "vitest";
import { applyFilter, type FilterDef } from "@/lib/pipeline/client-pipeline";

const fakeFilterDef = (col: string): FilterDef => ({
  key: col,
  column: col,
  bindTo: `/filters/${col}`,
  label: col,
  allowAll: true,
  dependsOn: null,
});

describe("applyFilter — backward compatibility (scalar filters)", () => {
  const data = [
    { region: "NA", revenue: 100 },
    { region: "EMEA", revenue: 200 },
    { region: "APAC", revenue: 150 },
  ];

  it("filters by exact string match", () => {
    const result = applyFilter(data, { region: "NA" }, [fakeFilterDef("region")]);
    expect(result).toEqual([{ region: "NA", revenue: 100 }]);
  });

  it("treats null/undefined/empty/All as no-op", () => {
    expect(applyFilter(data, { region: null }, [fakeFilterDef("region")])).toEqual(data);
    expect(applyFilter(data, { region: undefined }, [fakeFilterDef("region")])).toEqual(data);
    expect(applyFilter(data, { region: "" }, [fakeFilterDef("region")])).toEqual(data);
    expect(applyFilter(data, { region: "All" }, [fakeFilterDef("region")])).toEqual(data);
  });
});

describe("applyFilter — MultiSelect (string[])", () => {
  const data = [
    { region: "NA", revenue: 100 },
    { region: "EMEA", revenue: 200 },
    { region: "APAC", revenue: 150 },
    { region: "LATAM", revenue: 75 },
  ];

  it("keeps rows whose column matches any of the selected values", () => {
    const result = applyFilter(data, { region: ["NA", "EMEA"] }, [fakeFilterDef("region")]);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.region)).toEqual(["NA", "EMEA"]);
  });

  it("treats empty array as 'all'", () => {
    const result = applyFilter(data, { region: [] }, [fakeFilterDef("region")]);
    expect(result).toEqual(data);
  });

  it("works with single-element array (acts like membership of one)", () => {
    const result = applyFilter(data, { region: ["APAC"] }, [fakeFilterDef("region")]);
    expect(result).toEqual([{ region: "APAC", revenue: 150 }]);
  });

  it("compares as strings — handles numeric/string column heterogeneity", () => {
    const numericData = [
      { code: 1, label: "alpha" },
      { code: 2, label: "beta" },
      { code: 3, label: "gamma" },
    ];
    // Multi-select sends strings; column has numbers — match still works
    const result = applyFilter(numericData, { code: ["1", "3"] }, [fakeFilterDef("code")]);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.code)).toEqual([1, 3]);
  });
});

describe("applyFilter — RangeSlider ([low, high] tuple)", () => {
  const data = [
    { product: "A", price: 10 },
    { product: "B", price: 50 },
    { product: "C", price: 100 },
    { product: "D", price: 250 },
  ];

  it("keeps rows where the column falls within [low, high] inclusive", () => {
    const result = applyFilter(data, { price: [25, 150] }, [fakeFilterDef("price")]);
    expect(result.map((r) => r.product)).toEqual(["B", "C"]);
  });

  it("includes both endpoints (inclusive)", () => {
    const result = applyFilter(data, { price: [50, 100] }, [fakeFilterDef("price")]);
    expect(result.map((r) => r.product)).toEqual(["B", "C"]);
  });

  it("excludes rows whose column is non-numeric", () => {
    const mixed = [
      { name: "ok", price: 50 },
      { name: "bad", price: "n/a" as unknown as number },
    ];
    const result = applyFilter(mixed, { price: [0, 100] }, [fakeFilterDef("price")]);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("ok");
  });

  it("a tuple of two equal numbers acts like an exact-match", () => {
    const result = applyFilter(data, { price: [100, 100] }, [fakeFilterDef("price")]);
    expect(result).toEqual([{ product: "C", price: 100 }]);
  });

  it("does not collide with a string[] of two values (those are MultiSelect)", () => {
    // [number, number] → range; ["10", "100"] → membership test (strings)
    const result = applyFilter(data, { price: ["10", "100"] }, [fakeFilterDef("price")]);
    expect(result.map((r) => r.product)).toEqual(["A", "C"]);
  });
});

describe("applyFilter — composite filtering", () => {
  const data = [
    { region: "NA", category: "Electronics", price: 50 },
    { region: "NA", category: "Apparel", price: 30 },
    { region: "EMEA", category: "Electronics", price: 200 },
    { region: "APAC", category: "Apparel", price: 80 },
  ];

  it("AND-combines a multi-select and a range filter", () => {
    const result = applyFilter(data, { region: ["NA", "EMEA"], price: [40, 250] }, [
      fakeFilterDef("region"),
      fakeFilterDef("price"),
    ]);
    expect(result.map((r) => r.category)).toEqual(["Electronics", "Electronics"]);
  });

  it("AND-combines multi-select + scalar select", () => {
    const result = applyFilter(data, { region: ["NA", "EMEA"], category: "Electronics" }, [
      fakeFilterDef("region"),
      fakeFilterDef("category"),
    ]);
    expect(result).toHaveLength(2);
  });
});
