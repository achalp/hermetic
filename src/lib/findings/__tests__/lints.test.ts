import { describe, it, expect } from "vitest";
import { lintUnitPhrase, lintSentinelInterpolation } from "@/lib/findings/lints";

describe("lintUnitPhrase — prose re-uniting a bound value", () => {
  const units = new Map([
    ["churn_slope", "ratio"],
    ["step_2.churn_slope", "ratio"],
    ["mom_change", "pp"],
  ]);

  it("flags 'percentage points' prose around a ratio-declared finding (the 100x readout)", () => {
    const line = JSON.stringify({
      op: "add",
      path: "/elements/t1",
      value: {
        type: "TextBlock",
        props: {
          content: "an OLS slope of $finding:churn_slope.value percentage points per month",
        },
      },
    });
    const issues = lintUnitPhrase(line, units);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("unit_mismatch");
    expect(issues[0].name).toBe("churn_slope");
  });

  it("handles step-qualified names and stays quiet on matching units", () => {
    expect(
      lintUnitPhrase('"slope of $finding:step_2.churn_slope.value percent"', units)
    ).toHaveLength(1);
    expect(lintUnitPhrase('"rose $finding:mom_change.value pp since June"', units)).toHaveLength(0);
    expect(lintUnitPhrase('"slope of $finding:churn_slope.value per month"', units)).toHaveLength(
      0
    );
    expect(lintUnitPhrase('"unrelated $finding:unknown_name.value percent"', units)).toHaveLength(
      0
    );
  });
});

describe("lintSentinelInterpolation — flags/sentinels in word slots", () => {
  const findings = new Map<string, unknown>([
    ["heterogeneity_significant", true],
    ["base_effect", "none"],
    ["trend", { direction: "rising", slope: 0.009 }],
  ]);
  const results = { base_effect: "none", churn_direction: "rising" };

  it("flags a boolean bound inline ('rates are Yes')", () => {
    const line = '"Segment churn rates are $finding:heterogeneity_significant across the year."';
    const issues = lintSentinelInterpolation(line, { findings, results });
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("sentinel_interpolation");
    expect(issues[0].detail).toContain('"Yes"');
  });

  it("flags a 'none' sentinel in a verb slot, from findings or results", () => {
    const line =
      '"The base effect is $result:base_effect — the base size $finding:base_effect the signal."';
    const issues = lintSentinelInterpolation(line, { findings, results });
    expect(issues).toHaveLength(2);
  });

  it("allows whole-value bindings and meaningful words inline", () => {
    // Whole StatCard value: boolean renders as a standalone Yes — legitimate.
    expect(
      lintSentinelInterpolation('"value": "$finding:heterogeneity_significant"', {
        findings,
        results,
      })
    ).toHaveLength(0);
    // A direction word mid-sentence is exactly what inline binding is FOR.
    expect(
      lintSentinelInterpolation('"Churn is $result:churn_direction over the year"', {
        findings,
        results,
      })
    ).toHaveLength(0);
    // Structured field descent: rising is meaningful, not a sentinel.
    expect(
      lintSentinelInterpolation('"Churn is $finding:trend.direction across 2024"', {
        findings,
        results,
      })
    ).toHaveLength(0);
  });
});
