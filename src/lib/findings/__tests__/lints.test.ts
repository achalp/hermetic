import { describe, it, expect } from "vitest";
import {
  lintUnitPhrase,
  lintSentinelInterpolation,
  lintMissingLinkage,
  lintSignedLanguage,
} from "@/lib/findings/lints";

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

describe("lintMissingLinkage — the unwritable attribution sentence", () => {
  const step = {
    name: "churn_rate_step_change",
    definition: "largest month-over-month churn_rate jump vs baseline spread",
    dtype: "step_change",
    value: { period: "2024-08", delta: 4.4, baseline_spread: 0.46 },
  };
  const groups = {
    name: "segment_churn_trends",
    definition: "per-segment OLS churn_rate trends",
    dtype: "distribution",
    value: {
      "Self-Serve": { direction: "rising", slope_per_period: 1.3597 },
      Enterprise: { direction: "rising", slope_per_period: 0.1153 },
    },
  };

  it("flags a step-change + per-group pair with no finding deriving from both", () => {
    const issues = lintMissingLinkage([step, groups]);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("missing_linking_finding");
    expect(issues[0].detail).toContain("churn_rate_step_change");
    expect(issues[0].detail).toContain("segment_churn_trends");
  });

  it("stays quiet when a linking finding exists, or either shape is absent", () => {
    const link = {
      name: "step_change_attribution",
      definition: "the segment contributing most to the churn_rate step change",
      dtype: "attribution",
      value: { period: "2024-08", leading_group: "Self-Serve" },
      derived_from_findings: ["churn_rate_step_change", "segment_churn_trends"],
    };
    expect(lintMissingLinkage([step, groups, link])).toHaveLength(0);
    expect(lintMissingLinkage([step])).toHaveLength(0);
    expect(lintMissingLinkage([groups])).toHaveLength(0);
  });
});

describe("lintSignedLanguage — declines described as accelerations", () => {
  const findings = new Map<string, unknown>([
    ["monthly_step", { period: "2021-02", delta: -23808948, direction: "down" }],
  ]);
  const results = { step_delta: -23808948, rise_pp: 4.4 };

  it("flags positive-direction words around a negative bound value", () => {
    const line =
      '{"content": "The single largest step change was $finding:monthly_step.delta cases. This represents the sharpest acceleration in the series."}';
    const issues = lintSignedLanguage(line, { findings, results });
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("sign_mismatch");
    expect(issues[0].detail).toContain("acceleration");
  });

  it("flags negative words around a positive value, stays quiet on matches", () => {
    expect(
      lintSignedLanguage('{"content": "churn fell by $result:rise_pp since June"}', {
        findings,
        results,
      })
    ).toHaveLength(1);
    expect(
      lintSignedLanguage('{"content": "cases dropped $finding:monthly_step.delta in February"}', {
        findings,
        results,
      })
    ).toHaveLength(0);
    expect(
      lintSignedLanguage('{"content": "rose $result:rise_pp pp since June"}', {
        findings,
        results,
      })
    ).toHaveLength(0);
  });
});
