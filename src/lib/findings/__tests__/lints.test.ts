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
  lintNoChecksDeclared,
  lintMethodMismatch,
  lintDefinitionContradicted,
  lintChartConsistency,
  lintUndeclaredScreen,
  lintScreenScopeMismatch,
  lintSeriesConsumption,
  lintUnscreenedSuperlative,
  lintWellAttestedScreened,
  lintThinSuperlative,
  lintNullZeroMirror,
  lintSuperlativeHidesRaw,
  lintDanglingFindingReference,
  lintOrphanDecisionResult,
  lintUnweightedCountedTrend,
  lintMixedUnitGroupSeries,
} from "@/lib/findings/lints";
import { productRolesIndex } from "@/lib/product";

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

describe("lintMethodMismatch — declared vs computed test", () => {
  it("flags Kruskal-Wallis promised, anova recorded; accepts agreement", () => {
    const kw = {
      name: "era_heterogeneity",
      definition: "Kruskal-Wallis test of median price across eras",
      dtype: "check",
      value: { significant: true, p_value: 0.01, test: "anova" },
    };
    const issues = lintMethodMismatch([kw]);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("method_mismatch");
    expect(
      lintMethodMismatch([{ ...kw, value: { ...kw.value, test: "kruskal-wallis" } }])
    ).toHaveLength(0);
    expect(
      lintMethodMismatch([{ ...kw, definition: "significance test across eras" }])
    ).toHaveLength(0);
  });
});

describe("lintNoChecksDeclared — check presence is not optional", () => {
  const finding = (name: string) => ({
    name,
    definition: "a computed measure over the price column",
    dtype: "trend",
    value: { direction: "rising", p_value: 0.01 },
  });

  it("flags a rich manifest with zero checks; quiet with any check or few findings", () => {
    const many = [finding("a"), finding("b"), finding("c"), finding("d")];
    expect(lintNoChecksDeclared(many).map((i) => i.kind)).toEqual(["no_checks_declared"]);
    const withCheck = [
      ...many,
      {
        name: "grain_ok",
        definition: "grain validated against joined totals",
        dtype: "check",
        tags: ["check", "caveat"],
        value: { passed: true, divergence_pct: 0.2 },
      },
    ];
    expect(lintNoChecksDeclared(withCheck)).toHaveLength(0);
    expect(lintNoChecksDeclared([finding("a")])).toHaveLength(0);
  });
});

describe("lintDefinitionContradicted — is_X false beside a definition asserting X", () => {
  it("flags the four-run min_price_boolean_flag shape; accepts negated definitions", () => {
    const bad = {
      name: "min_price_boolean_flag",
      definition: "min_price is a boolean completeness flag for each year row",
      dtype: "check",
      value: { passed: true, is_boolean: false, zero_rows: 140 },
    };
    const issues = lintDefinitionContradicted([bad]);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("definition_contradicted");
    const negated = { ...bad, definition: "min_price is NOT boolean; treated as continuous" };
    expect(lintDefinitionContradicted([negated])).toHaveLength(0);
  });
});

describe("lintChartConsistency — one payload, one policy (run-30)", () => {
  const chartData = {
    price_trend_over_time: [
      { year: 1966, max_price: null },
      { year: 1980, avg_price: null, max_price: null },
    ],
    price_spread_over_time: [
      { year: 1966, max_price: 10000 },
      { year: 1980, avg_price: 836.5, max_price: 30000 },
    ],
  };

  it("flags the same cell null in one series and valued in another", () => {
    const issues = lintChartConsistency(chartData, []);
    expect(issues.some((i) => i.kind === "chart_policy_divergence")).toBe(true);
  });

  it("flags a peak superlative a chart column exceeds; consistent data quiet", () => {
    const peak = {
      name: "peak_max_price",
      definition: "highest recorded dish price",
      dtype: "superlative",
      value: { year: 1955, value: 7000 },
    };
    const issues = lintChartConsistency(chartData, [peak]);
    expect(issues.some((i) => i.kind === "superlative_contradicted_by_chart")).toBe(true);
    const clean = {
      series_a: [{ year: 1966, max_price: 10000 }],
      series_b: [{ year: 1966, max_price: 10000 }],
    };
    expect(
      lintChartConsistency(clean, [{ ...peak, value: { year: 1966, value: 10000 } }])
    ).toHaveLength(0);
  });

  it("scopes cells per step: cross-step policy differences are not divergences", () => {
    // Step 1 screens 1966; step 2 (a different sub-question, different
    // policy) keeps it. Same column, same x, different steps — legitimate.
    const crossStep = {
      step_1_price_trend: [{ year: 1966, max_price: null }],
      step_2_price_spread: [{ year: 1966, max_price: 10000 }],
    };
    expect(lintChartConsistency(crossStep, [])).toHaveLength(0);
    // The SAME divergence inside one step still flags.
    const sameStep = {
      step_1_price_trend: [{ year: 1966, max_price: null }],
      step_1_price_spread: [{ year: 1966, max_price: 10000 }],
    };
    expect(
      lintChartConsistency(sameStep, []).some((i) => i.kind === "chart_policy_divergence")
    ).toBe(true);
  });

  it("checks a step-scoped superlative only against its own step's charts", () => {
    const peak = {
      name: "step_2.peak_max_price",
      definition: "highest recorded dish price in the screened subset",
      dtype: "superlative",
      value: { year: 1955, value: 7000 },
    };
    // Step 3's unscreened chart exceeds the step-2 peak — different scope,
    // not a contradiction.
    const otherStep = { step_3_prices: [{ year: 1966, max_price: 30000 }] };
    expect(lintChartConsistency(otherStep, [peak])).toHaveLength(0);
    // The same excess inside step 2's own chart IS a contradiction.
    const ownStep = { step_2_prices: [{ year: 1966, max_price: 30000 }] };
    expect(
      lintChartConsistency(ownStep, [peak]).some(
        (i) => i.kind === "superlative_contradicted_by_chart"
      )
    ).toBe(true);
  });
});

describe("lintUndeclaredScreen — every screened series has a contract (run-32)", () => {
  const chartData = {
    price_trends: [
      { year: 1966, max_price_usd: 10000, max_price_screened_usd: null },
      { year: 1955, max_price_usd: 7000, max_price_screened_usd: 7000 },
    ],
  };

  it("flags a *_screened column with no declaring check", () => {
    const issues = lintUndeclaredScreen(chartData, []);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("undeclared_screen");
    expect(issues[0].detail).toContain("max_price");
  });

  it("quiet when a check declares the screen over that column", () => {
    const check = {
      name: "max_price_outlier_screen",
      definition: "values above 8100 excluded as transcription errors from max_price",
      dtype: "check",
      tags: ["check", "caveat"],
      value: { passed: false, threshold_usd: 8100, n_excluded: 2 },
    };
    expect(lintUndeclaredScreen(chartData, [check])).toHaveLength(0);
  });
});

describe("weak_check — evidence without numbers is a label (run-32)", () => {
  it("flags string-only evidence; numeric evidence passes", () => {
    const label = {
      name: "early_late_window_comparability",
      definition: "windows produced by the pinned midpoint split are comparable",
      dtype: "check",
      tags: ["check", "caveat"],
      value: {
        passed: true,
        split_method: "pinned midpoint",
        series_used: "positive-median years",
      },
    };
    const issues = lintCheckGating([label]);
    expect(issues.some((i) => i.kind === "weak_check" && i.detail.includes("NUMERIC"))).toBe(true);
    const real = { ...label, value: { ...label.value, early_n: 47, late_n: 47 } };
    expect(lintCheckGating([real])).toHaveLength(0);
  });
});

describe("lintScreenScopeMismatch — applied vs declared exclusion sets (run-33)", () => {
  const chartData = {
    price_trends: [
      { year: 1966, max_price: 10000, max_price_screened: null },
      { year: 1980, max_price: 30000, max_price_screened: null },
      { year: 2012, max_price: 2500, max_price_screened: 2500 },
    ],
  };
  const declared = {
    name: "avg_price_outlier_screen",
    definition: "avg_price and max_price values above threshold excluded as outliers",
    dtype: "check",
    tags: ["check", "caveat"],
    value: { passed: false, excluded_years: [1980, 1999, 2012], threshold: 124.9 },
  };

  it("flags exclusions outside the declared set", () => {
    const issues = lintScreenScopeMismatch(chartData, [declared]);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("screen_scope_mismatch");
    expect(issues[0].detail).toContain("1966");
  });

  it("quiet when applied set is within the declaration", () => {
    const wider = { ...declared, value: { ...declared.value, excluded_years: [1966, 1980] } };
    expect(lintScreenScopeMismatch(chartData, [wider])).toHaveLength(0);
  });
});

describe("lintSeriesConsumption — raw-vs-screened choice must be declared (run-33)", () => {
  it("flags a raw-only consumer beside a screened sibling elsewhere", () => {
    const chartData = {
      decade_rollup: [{ decade: "1980s", avg_price: 94.67 }],
      screened_line: [{ year: 1980, avg_price: 836.47, avg_price_screened: null }],
    };
    const issues = lintSeriesConsumption(chartData);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("undeclared_series_choice");
    expect(issues[0].detail).toContain("decade_rollup");
  });
});

describe("lintUnscreenedSuperlative — the outlier policy as a detector (run-35)", () => {
  const chartData = {
    price_trends: [
      { year: 1950, max_price: 5 },
      { year: 1955, max_price: 7 },
      { year: 1960, max_price: 6 },
      { year: 1966, max_price: 10000 },
      { year: 1970, max_price: 8 },
      { year: 1980, max_price: 30000 },
    ],
  };
  const peak = {
    name: "peak_max_price",
    definition: "highest recorded dish price in the corpus",
    dtype: "superlative",
    value: { year: 1980, value: 30000 },
  };

  it("flags a raw peak dwarfing its column median with no screened series", () => {
    const issues = lintUnscreenedSuperlative(chartData, [peak]);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("unscreened_superlative");
  });

  it("a proportionate peak is quiet; a same-chart screened peak is quiet", () => {
    // Per-value semantics (run-38): only the VALUE itself being screened
    // suppresses — a screened series elsewhere in the payload does not
    // (that was the loophole error clusters hid behind).
    const modest = { ...peak, value: { year: 1955, value: 7 } };
    expect(lintUnscreenedSuperlative(chartData, [modest])).toHaveLength(0);
    const sameChart = {
      price_trends: chartData.price_trends.map((r) =>
        r.year === 1980
          ? { ...r, max_price_screened: null }
          : { ...r, max_price_screened: r.max_price }
      ),
    };
    expect(lintUnscreenedSuperlative(sameChart, [peak])).toHaveLength(0);
  });
});

describe("lintWellAttestedScreened — screening data as error (run-37: 2012/$38)", () => {
  const chartData = {
    price_trends: [
      { year: 1997, median_price: 19, median_price_screened: 19, item_count: 515 },
      { year: 2000, median_price: 4, median_price_screened: 4, item_count: 300 },
      { year: 2005, median_price: 6, median_price_screened: 6, item_count: 400 },
      { year: 2010, median_price: 12, median_price_screened: 12, item_count: 200 },
      { year: 2012, median_price: 38, median_price_screened: null, item_count: 1312 },
    ],
  };

  it("flags a screened value backed by above-median counts", () => {
    const issues = lintWellAttestedScreened(chartData);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("well_attested_screened");
    expect(issues[0].detail).toContain("2012");
  });

  it("quiet when the screened value is thin", () => {
    const thin = {
      price_trends: chartData.price_trends.map((r) =>
        r.year === 2012 ? { ...r, item_count: 3 } : r
      ),
    };
    expect(lintWellAttestedScreened(thin)).toHaveLength(0);
  });
});

describe("lintNullZeroMirror — one absence, two representations (run-37)", () => {
  it("flags results 0 mirroring a null finding field; honest mirrors pass", () => {
    const finding = {
      name: "median_price_step_change",
      definition: "largest persistent step in the median series",
      dtype: "step_change",
      value: { period: null, delta: null, direction: null, baseline_spread: 0.4 },
    };
    const issues = lintNullZeroMirror({ median_price_step_change_delta: 0 }, [finding]);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("null_zero_mirror");
    expect(lintNullZeroMirror({ median_price_step_change_delta: null }, [finding])).toHaveLength(0);
  });
});

describe("screen_missed_superlative — error clusters validating each other (run-38)", () => {
  const rows = [
    { year: 1950, max_price: 5, max_price_screened: 5 },
    { year: 1955, max_price: 7, max_price_screened: 7 },
    { year: 1966, max_price: 10000, max_price_screened: null },
    { year: 1970, max_price: 8, max_price_screened: 8 },
    { year: 1980, max_price: 30000, max_price_screened: 30000 },
    { year: 1990, max_price: 9, max_price_screened: 9 },
  ];
  const peak = {
    name: "peak_max_price",
    definition: "highest recorded price",
    dtype: "superlative",
    value: { year: 1980, value: 30000 },
  };

  it("flags a screen that let the peak through", () => {
    const issues = lintUnscreenedSuperlative({ series: rows }, [peak]);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("screen_missed_superlative");
  });

  it("quiet when the peak WAS screened", () => {
    const screenedPeak = { ...peak, value: { year: 1966, value: 10000 } };
    expect(lintUnscreenedSuperlative({ series: rows }, [screenedPeak])).toHaveLength(0);
  });
});

describe("lintThinSuperlative — a 52-item year crowned (run-39)", () => {
  const chartData = {
    trends: [
      { year: 1996, median_price: 74, item_count: 52 },
      { year: 2000, median_price: 8, item_count: 400 },
      { year: 2005, median_price: 12, item_count: 600 },
      { year: 2010, median_price: 20, item_count: 800 },
      { year: 2012, median_price: 45, item_count: 1217 },
    ],
  };

  it("flags a peak resting on sub-20%-of-median counts", () => {
    const peak = {
      name: "peak_median_price",
      definition: "highest annual median price",
      dtype: "superlative",
      value: { period: "1996", value: 74 },
    };
    const issues = lintThinSuperlative(chartData, [peak]);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("thin_superlative");
  });

  it("a well-attested peak passes", () => {
    const peak = {
      name: "peak_median_price",
      definition: "highest annual median price",
      dtype: "superlative",
      value: { period: "2012", value: 45 },
    };
    expect(lintThinSuperlative(chartData, [peak])).toHaveLength(0);
  });

  it("flags a current-state whose endpoint is a thin tail (484-item 2000s decade)", () => {
    // Same detector, second shape: pct_from_peak measured against an
    // unattested edge narrates a collection gap as a price decline.
    const current = {
      name: "price_current_state",
      definition: "where the price series ends relative to its peak",
      dtype: "current_state",
      value: { period: "1996", value: 74, pct_from_peak: -50.2, direction: "falling" },
    };
    const issues = lintThinSuperlative(chartData, [current]);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("thin_current_state");
    expect(issues[0].detail).toContain("counts=");
    // Well-attested endpoint: quiet.
    const attested = { ...current, value: { ...current.value, period: "2012" } };
    expect(lintThinSuperlative(chartData, [attested])).toHaveLength(0);
    // Null pct_from_peak (walked back / unavailable): quiet.
    const nulled = { ...current, value: { ...current.value, pct_from_peak: null } };
    expect(lintThinSuperlative(chartData, [nulled])).toHaveLength(0);
  });
});

describe("lintSuperlativeHidesRaw — the 0.4-vs-26 audit finding", () => {
  const peak = {
    name: "median_price_peak",
    definition: "attestation-weighted peak of annual median price",
    dtype: "superlative",
    value: {
      period: "1917",
      value: 0.4,
      raw_period: "2012",
      raw_value: 26,
      thin_periods_skipped: 120,
    },
  };

  it("fires when the attested value is narrated and the raw extreme appears nowhere", () => {
    const issues = lintSuperlativeHidesRaw([peak], ["The series peaked in 1917 at 0.4 usd."]);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("superlative_hides_raw");
    expect(issues[0].detail).toContain("26");
    expect(issues[0].detail).toContain("thin_periods_skipped=120");
  });

  it("quiet when the raw extreme is stated beside the attested value", () => {
    const text = [
      "Peaked at 0.4 usd in 1917 among well-covered years; the raw maximum 26 (2012) sits in a thinly-covered year.",
    ];
    expect(lintSuperlativeHidesRaw([peak], text)).toHaveLength(0);
  });

  it("quiet when raw and attested agree, when the value is not narrated, and with no prose", () => {
    const agree = { ...peak, value: { ...peak.value, raw_value: 0.45 } };
    expect(lintSuperlativeHidesRaw([agree], ["Peaked at 0.4 usd."])).toHaveLength(0);
    expect(lintSuperlativeHidesRaw([peak], ["Prices rose steadily."])).toHaveLength(0);
    expect(lintSuperlativeHidesRaw([peak], [])).toHaveLength(0);
  });

  it("fires for a current-state whose raw endpoint vanished (the 68-year walk-back)", () => {
    const current = {
      name: "price_current_state",
      definition: "attested endpoint of the price series",
      dtype: "current_state",
      value: {
        period: "1933",
        value: 0.4,
        pct_from_peak: 0,
        excluded_trailing: 68,
        latest_period: "2012",
        latest_value: 26,
        latest_n: 382,
      },
    };
    const issues = lintSuperlativeHidesRaw(
      [current],
      ["Well-covered data ends in 1933 at 0.4 usd."]
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].detail).toContain("26");
    expect(issues[0].detail).toContain("excluded_trailing=68");
    // Quiet when the latest raw observation is stated.
    expect(
      lintSuperlativeHidesRaw(
        [current],
        ["Well-covered data ends 1933 at 0.4 usd; the latest raw observation is 26 usd (2012)."]
      )
    ).toHaveLength(0);
  });
});

describe("mirror_dropped_value — results losing a value the manifest carries (run-41)", () => {
  it("flags results null beside a non-null finding field", () => {
    const finding = {
      name: "median_price_distribution",
      definition: "robust shape summary of annual medians",
      dtype: "distribution",
      value: { skew: 4.25, mean: 5.2, median: 0.9 },
    };
    const issues = lintNullZeroMirror({ median_price_distribution_skew: null }, [finding]);
    expect(issues.some((i) => i.kind === "mirror_dropped_value")).toBe(true);
    expect(lintNullZeroMirror({ median_price_distribution_skew: 4.25 }, [finding])).toHaveLength(0);
  });
});

describe("referent integrity — prose, results, and executed screens point at real declarations", () => {
  const FINDINGS = [
    {
      name: "item_volume_trend",
      definition: "OLS trend of items per year",
      dtype: "trend",
      value: { direction: "rising", weighted: false },
    },
    {
      name: "currency_restriction",
      definition: "analysis restricted to the dominant currency; preferred price metric median",
      dtype: "check",
      value: { passed: true },
    },
  ];

  it("dangling finding citation in prose is flagged; real citations are not", () => {
    const issues = lintDanglingFindingReference(
      ["The trend (median_price_trend finding) reflects the dominant currency only."],
      FINDINGS
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("dangling_finding_reference");
    expect(issues[0].name).toBe("median_price_trend");
    expect(
      lintDanglingFindingReference(["Per the item_volume_trend finding, volume rose."], FINDINGS)
    ).toHaveLength(0);
    // Plain snake_case prose without a finding/check citation is not flagged.
    expect(
      lintDanglingFindingReference(["column avg_price_raw holds the unscreened values"], FINDINGS)
    ).toHaveLength(0);
  });

  it("executed-but-undeclared screen: null beside a _raw sibling with no declaring check", () => {
    const chartData = {
      prices_by_year: [
        { year: 1985, avg_price: 12.1, avg_price_raw: 12.1 },
        { year: 1986, avg_price: null, avg_price_raw: 13.68 },
      ],
    };
    const issues = lintUndeclaredScreen(chartData, []);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe("undeclared_screen");
    expect(issues[0].detail).toContain("avg_price");
    // A declaring check quiets it; a pair with NO divergence proves nothing.
    const check = {
      name: "avg_price_outlier_screen",
      definition: "outlier screen over avg_price: rolling-MAD, flagged years nulled",
      dtype: "check",
      value: { passed: false, n_excluded: 1 },
    };
    expect(lintUndeclaredScreen(chartData, [check])).toHaveLength(0);
    const clean = {
      prices_by_year: [{ year: 1986, avg_price: 13.68, avg_price_raw: 13.68 }],
    };
    expect(lintUndeclaredScreen(clean, [])).toHaveLength(0);
  });

  it("orphan decision results are flagged; declared decisions are not", () => {
    const results = {
      preferred_price_metric: "median_price",
      preferred_price_metric_reason: "heavy tail",
      split_at_year: 1940,
      median_price_1950: 0.65,
    };
    const issues = lintOrphanDecisionResult(results, FINDINGS);
    const kinds = issues.map((i) => i.name);
    expect(kinds).toContain("split_at_year");
    // The _reason key rides its base key — flagged once, not twice.
    expect(kinds).not.toContain("preferred_price_metric_reason");
    // A finding sharing the decision's tokens backs it.
    const declared = [
      ...FINDINGS,
      {
        name: "preferred_price_metric_choice",
        definition: "metric choice: median over mean under heavy tail",
        dtype: "check",
        value: { passed: true },
      },
    ];
    expect(lintOrphanDecisionResult(results, declared).map((i) => i.name)).not.toContain(
      "preferred_price_metric"
    );
  });

  it("unweighted trend over a counted series is flagged; weighted is quiet", () => {
    const series = [
      {
        id: "dish_counts",
        rows: [{ year: 1900, dishes: 100, n: 500 }],
        roles: {
          x: { column: "year", kind: "temporal" },
          measures: [{ column: "dishes" }],
          count: { column: "n" },
        },
      },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rolesIdx = productRolesIndex(series as any);
    const unweighted = lintUnweightedCountedTrend(FINDINGS, rolesIdx);
    expect(unweighted).toHaveLength(1);
    expect(unweighted[0].kind).toBe("unweighted_counted_trend");
    const weightedFinding = [{ ...FINDINGS[0], value: { direction: "falling", weighted: true } }];
    expect(lintUnweightedCountedTrend(weightedFinding, rolesIdx)).toHaveLength(0);
    expect(lintUnweightedCountedTrend(FINDINGS, undefined)).toHaveLength(0);
  });

  it("monetary measure grouped by a currency column is flagged; ordinary groups are not", () => {
    const mk = (groupCol: string) => [
      {
        id: "price_by_top_currency_over_time",
        rows: [{ year: 1900, median_price: 0.6, currency: "Dollars" }],
        roles: {
          x: { column: "year", kind: "temporal" },
          measures: [{ column: "median_price", unit: "usd" }],
          group: { column: groupCol },
        },
      },
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const flagged = lintMixedUnitGroupSeries(productRolesIndex(mk("currency") as any));
    expect(flagged).toHaveLength(1);
    expect(flagged[0].kind).toBe("mixed_unit_group_series");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(lintMixedUnitGroupSeries(productRolesIndex(mk("segment") as any))).toHaveLength(0);
  });
});
