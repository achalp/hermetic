import { describe, it, expect } from "vitest";
import { unwrapChartData } from "@/lib/chart-theme";

describe("unwrapChartData", () => {
  const rows = [{ a: 1 }, { a: 2 }];

  it("passes through a bare array", () => {
    expect(unwrapChartData(rows)).toBe(rows);
  });

  it("unwraps {data: [...]}", () => {
    expect(unwrapChartData({ data: rows })).toEqual(rows);
  });

  it("unwraps {rows: [...]}", () => {
    expect(unwrapChartData({ rows })).toEqual(rows);
  });

  it("unwraps a single-key array wrapper", () => {
    expect(unwrapChartData({ records: rows })).toEqual(rows);
  });

  it("prefers data over a sibling key", () => {
    expect(unwrapChartData({ data: rows, meta: { n: 2 } })).toEqual(rows);
  });

  it("returns [] for non-array / unrecognized shapes", () => {
    expect(unwrapChartData(null)).toEqual([]);
    expect(unwrapChartData(undefined)).toEqual([]);
    expect(unwrapChartData(42)).toEqual([]);
    expect(unwrapChartData({ a: 1, b: 2 })).toEqual([]);
  });
});
