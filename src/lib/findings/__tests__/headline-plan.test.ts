import { describe, it, expect } from "vitest";
import { planHeadlineTiles } from "@/lib/findings/headline-plan";

const findings = [
  {
    name: "cases_trend",
    definition: "OLS trend of monthly cases",
    dtype: "direction",
    value: { direction: "rising", slope_per_period: 842962.24, p_value: 6.7e-6 },
  },
  {
    name: "cases_yoy",
    definition: "like-for-like yoy",
    dtype: "comparison",
    value: { prior_year: 2020, latest_year: 2021, window_months: [1, 2], pct_change: 234.8 },
  },
  {
    name: "cases_current_state",
    definition: "ending state from last complete period",
    dtype: "state",
    value: { period: "2021-10", value: 8694867, pct_from_peak: -61.44, excluded_trailing: 0 },
  },
  {
    name: "peak_monthly_cases",
    definition: "peak month",
    dtype: "superlative",
    value: { month: "2021-04", value: 22547092 },
  },
];

describe("planHeadlineTiles — the server owns the headline set", () => {
  it("derives level, change, current-state, and peak tiles from a rich manifest", () => {
    const tiles = planHeadlineTiles(findings, { total_cases_in_period: 240643265 });
    const bindings = tiles.map((t) => t.binding);
    expect(bindings).toContain("$result:total_cases_in_period");
    expect(bindings).toContain("$finding:cases_yoy.pct_change");
    expect(bindings).toContain("$finding:cases_current_state.pct_from_peak");
    expect(bindings).toContain("$finding:peak_monthly_cases.value");
    expect(tiles.length).toBeGreaterThanOrEqual(4);
  });

  it("prefers yoy over slope for the change tile, empty manifest plans nothing", () => {
    const tiles = planHeadlineTiles(findings, {});
    expect(tiles.some((t) => t.binding === "$finding:cases_yoy.pct_change")).toBe(true);
    expect(tiles.some((t) => t.binding.includes("slope"))).toBe(false);
    expect(planHeadlineTiles([], {})).toHaveLength(0);
  });
});

describe("tautological-delta guard (run-26: 'Current vs Peak: 0')", () => {
  it("skips a zero pct_from_peak tile; keeps a real one", () => {
    const atPeak = [
      {
        name: "median_price_current_state",
        definition: "ending state",
        dtype: "current_state",
        value: { period: "2012", value: 9.25, pct_from_peak: 0, excluded_trailing: 1 },
      },
    ];
    expect(planHeadlineTiles(atPeak, {}).some((t) => t.binding.includes("pct_from_peak"))).toBe(
      false
    );
    const below = [{ ...atPeak[0], value: { ...atPeak[0].value, pct_from_peak: -61.4 } }];
    expect(planHeadlineTiles(below, {}).some((t) => t.binding.includes("pct_from_peak"))).toBe(
      true
    );
  });
});
