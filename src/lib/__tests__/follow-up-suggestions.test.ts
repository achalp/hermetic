import { describe, it, expect } from "vitest";
import { summarizeAnalysisResults } from "@/lib/suggest-questions";
import { extractSpecComponentTypes } from "@/lib/spec-summary";
import type { Spec } from "@/spec/react";

describe("summarizeAnalysisResults", () => {
  it("returns empty object for undefined input", () => {
    expect(summarizeAnalysisResults(undefined)).toEqual({});
  });

  it("returns empty object for empty input", () => {
    expect(summarizeAnalysisResults({})).toEqual({});
  });

  it("stringifies scalar values", () => {
    const result = summarizeAnalysisResults({
      total_revenue: 1234567,
      growth_rate: 0.18,
      top_region: "EMEA",
      is_growing: true,
    });
    expect(result).toEqual({
      total_revenue: "1234567",
      growth_rate: "0.18",
      top_region: "EMEA",
      is_growing: "true",
    });
  });

  it("drops null and undefined values", () => {
    const result = summarizeAnalysisResults({
      total: 100,
      missing: null,
      gone: undefined,
      present: "hello",
    });
    expect(result).toEqual({ total: "100", present: "hello" });
  });

  it("caps the number of keys", () => {
    const input: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) input[`key${i}`] = i;
    const result = summarizeAnalysisResults(input, 5);
    expect(Object.keys(result)).toHaveLength(5);
  });

  it("truncates long values", () => {
    const long = "x".repeat(500);
    const result = summarizeAnalysisResults({ msg: long }, 12, 50);
    expect(result.msg.length).toBeLessThanOrEqual(50);
  });

  it("serializes objects (truncated)", () => {
    const result = summarizeAnalysisResults({ breakdown: { a: 1, b: 2, c: 3 } }, 12, 120);
    expect(result.breakdown).toContain('"a":1');
  });
});

describe("extractSpecComponentTypes", () => {
  it("returns empty array for empty spec", () => {
    const spec: Spec = { root: "root", elements: {} };
    expect(extractSpecComponentTypes(spec)).toEqual([]);
  });

  it("walks tree in document order", () => {
    const spec: Spec = {
      root: "r",
      elements: {
        r: {
          type: "LayoutGrid",
          props: {},
          children: ["s1", "c1", "t1"],
        },
        s1: { type: "StatCard", props: { label: "Total", value: 100 } },
        c1: { type: "BarChart", props: { title: "Sales" } },
        t1: { type: "DataTable", props: {} },
      },
    } as unknown as Spec;
    expect(extractSpecComponentTypes(spec)).toEqual([
      "LayoutGrid",
      "StatCard",
      "BarChart",
      "DataTable",
    ]);
  });

  it("handles nested children", () => {
    const spec: Spec = {
      root: "r",
      elements: {
        r: { type: "LayoutColumn", props: {}, children: ["row"] },
        row: {
          type: "LayoutRow",
          props: {},
          children: ["s1", "s2"],
        },
        s1: { type: "StatCard", props: {} },
        s2: { type: "StatCard", props: {} },
      },
    } as unknown as Spec;
    expect(extractSpecComponentTypes(spec)).toEqual([
      "LayoutColumn",
      "LayoutRow",
      "StatCard",
      "StatCard",
    ]);
  });

  it("ignores missing element references gracefully", () => {
    const spec: Spec = {
      root: "r",
      elements: {
        r: { type: "Container", props: {}, children: ["missing", "s1"] },
        s1: { type: "StatCard", props: {} },
      },
    } as unknown as Spec;
    expect(extractSpecComponentTypes(spec)).toEqual(["Container", "StatCard"]);
  });
});
