import { describe, it, expect } from "vitest";
import {
  lintUnitPhrase,
  lintSentinelInterpolation,
  lintMissingLinkage,
  lintSignedLanguage,
  lintGranularityConflict,
  lintCompletenessConflict,
  lintTrendContract,
  lintRangeFabrication,
  lintCheckGating,
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

describe("lintGranularityConflict — monthly rising vs quarterly flat", () => {
  const monthly = {
    name: "cases_trend_monthly",
    definition: "OLS trend of monthly new_confirmed cases",
    dtype: "direction",
    value: { direction: "rising", slope_per_period: 2007380, p_value: 3.5e-5 },
  };
  const quarterly = {
    name: "cases_trend_quarterly",
    definition: "OLS trend of quarterly new_confirmed cases",
    dtype: "direction",
    value: { direction: "flat", slope_per_period: 4100000, p_value: 0.246 },
  };
  const unrelated = {
    name: "churn_rate_trend",
    definition: "OLS trend of monthly churn_rate",
    dtype: "direction",
    value: { direction: "falling" },
  };

  it("flags disagreeing directions on the same measure", () => {
    const issues = lintGranularityConflict([monthly, quarterly]);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("granularity_conflict");
    expect(issues[0].detail).toContain("rising");
    expect(issues[0].detail).toContain("flat");
  });

  it("ignores different measures and agreeing directions", () => {
    expect(lintGranularityConflict([monthly, unrelated])).toHaveLength(0);
    expect(
      lintGranularityConflict([monthly, { ...quarterly, value: { direction: "rising" } }])
    ).toHaveLength(0);
  });
});

describe("lintCompletenessConflict — profiler vs ending-state findings", () => {
  const profile = {
    time_column: "date",
    entity_column: "location_key",
    trailing_incomplete: [
      { period: "2021-10-24", coverage: 13, baseline_coverage: 231 },
      { period: "2021-10-25", coverage: 3, baseline_coverage: 231 },
    ],
    leading_incomplete: [],
  };
  const endingState = {
    name: "cases_current_state",
    definition: "ending state",
    dtype: "state",
    value: { period: "2021-10", value: 8694867, pct_from_peak: -61.44, excluded_trailing: 0 },
  };

  it("flags an ending-state finding that excluded nothing against a dirty edge", () => {
    const issues = lintCompletenessConflict([endingState], profile);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("completeness_conflict");
    expect(issues[0].detail).toContain("cases_current_state");
  });

  it("flags a dirty edge with no ending-state finding; quiet when clean or accounted", () => {
    expect(lintCompletenessConflict([], profile)).toHaveLength(1);
    expect(lintCompletenessConflict([endingState], null)).toHaveLength(0);
    const accounted = { ...endingState, value: { ...endingState.value, excluded_trailing: 2 } };
    expect(lintCompletenessConflict([accounted], profile)).toHaveLength(0);
  });
});

describe("lintTrendContract — directions are a contract", () => {
  it("flags a non-direction word and an insignificant non-flat direction", () => {
    const issues = lintTrendContract([
      {
        name: "avg_lowest_price_trend",
        definition: "trend of avg lowest price",
        dtype: "direction",
        value: { direction: "regime_change", slope_per_period: 0.0088, p_value: 0.9944 },
      },
      {
        name: "max_price_trend",
        definition: "trend of max price",
        dtype: "direction",
        value: { direction: "rising", slope_per_period: 0.4, p_value: 0.51 },
      },
    ]);
    expect(issues.map((i) => i.kind)).toEqual([
      "nonstandard_direction",
      "insignificant_trend_direction",
    ]);
  });

  it("accepts helper-contract directions with significant fits", () => {
    expect(
      lintTrendContract([
        {
          name: "decade_trend",
          definition: "decade trend",
          dtype: "direction",
          value: { direction: "rising", p_value: 0.0015 },
        },
        {
          name: "flat_trend",
          definition: "flat",
          dtype: "direction",
          value: { direction: "flat", p_value: 0.9 },
        },
      ])
    ).toHaveLength(0);
  });
});

describe("lintRangeFabrication — framing must match the observed range", () => {
  const completeness = { time_min: "1851-01-01", time_max: "2012-12-31" };

  it("flags definitions citing years outside the profiled range", () => {
    const issues = lintRangeFabrication(
      [
        {
          name: "era_avg_price",
          definition: "average dish price per era over 1820-2020, eras cut at 1880/1920/1960",
          dtype: "distribution",
          value: {},
        },
      ],
      completeness
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].detail).toContain("1820");
    expect(issues[0].detail).toContain("2020");
  });

  it("accepts in-range framing and missing profiles", () => {
    const ok = [
      {
        name: "x",
        definition: "trend over 1851-2012 by year",
        dtype: "direction",
        value: {},
      },
    ];
    expect(lintRangeFabrication(ok, completeness)).toHaveLength(0);
    expect(lintRangeFabrication(ok, null)).toHaveLength(0);
  });
});

describe("lintCheckGating — declared-checks enforcement", () => {
  const failedCheck = {
    name: "join_vs_shortcut_divergence",
    definition: "joined totals vs dish lifetime shortcut differ by <2%",
    dtype: "check",
    tags: ["check", "blocking"],
    value: { passed: false, divergence_pct: 174.0 },
  };
  const dependent = {
    name: "avg_price_by_year",
    definition: "average price by debut year from the dish table",
    dtype: "distribution",
    value: { y2004: 21.45 },
    derived_from_findings: ["join_vs_shortcut_divergence"],
  };

  it("flags findings resting on a failed check, and heeded lineage silences the unheeded flag", () => {
    const issues = lintCheckGating([failedCheck, dependent]);
    expect(issues.map((i) => i.kind)).toEqual(["rests_on_failed_check"]);
  });

  it("flags an unheeded failed blocking check and self-graded checks", () => {
    const issues = lintCheckGating([failedCheck]);
    expect(issues.map((i) => i.kind)).toEqual(["unheeded_blocking_check"]);
    const weak = {
      name: "vibes",
      definition: "the data seems fine overall today",
      dtype: "check",
      tags: ["check", "caveat"],
      value: { passed: true },
    };
    expect(lintCheckGating([weak]).map((i) => i.kind)).toEqual(["weak_check"]);
  });

  it("passing evidence-bearing checks are silent", () => {
    const ok = { ...failedCheck, value: { passed: true, divergence_pct: 0.4 } };
    expect(lintCheckGating([ok, { ...dependent }])).toHaveLength(0);
  });
});
