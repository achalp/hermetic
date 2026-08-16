import { describe, it, expect } from "vitest";
import { normalizeSeries } from "@/components/charts/dual-axis-chart";

/**
 * The DualAxis bug: the LLM emits series as bare strings (`["churn_mrr"]`)
 * while the component read `s.key` — undefined for a string — so every y became
 * `Number(row[undefined]) || 0` and the chart plotted flat at zero. normalizeSeries
 * accepts both the string and object forms.
 */
describe("normalizeSeries (DualAxis)", () => {
  it("turns bare column-name strings into {key} specs", () => {
    expect(normalizeSeries(["churn_mrr", "churn_rate_pct"])).toEqual([
      { key: "churn_mrr" },
      { key: "churn_rate_pct" },
    ]);
  });

  it("passes object specs through unchanged", () => {
    const spec = [{ key: "revenue", label: "Revenue", type: "bar" as const, color: "#123456" }];
    expect(normalizeSeries(spec)).toEqual(spec);
  });

  it("handles a mixed array", () => {
    expect(normalizeSeries(["a", { key: "b", label: "B" }])).toEqual([
      { key: "a" },
      { key: "b", label: "B" },
    ]);
  });

  it("drops entries without a usable key (no phantom zero series)", () => {
    expect(normalizeSeries(["", { label: "no key" }, null, 5])).toEqual([]);
  });

  it("returns [] for a non-array", () => {
    expect(normalizeSeries(undefined)).toEqual([]);
    expect(normalizeSeries("churn_mrr")).toEqual([]);
  });
});
