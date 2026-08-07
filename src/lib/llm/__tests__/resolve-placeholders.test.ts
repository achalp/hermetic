import { describe, it, expect } from "vitest";
import { resolveSpecPlaceholders, repairStateBindings } from "@/lib/llm/resolve-placeholders";

// Lever 2: the composer sometimes references a chart_data key the analysis code
// produced under a slightly different name. We repair confident, unique near-
// misses against produced keys, but never guess between unrelated candidates
// (a wrong bind is worse than a blank chart).
describe("resolveSpecPlaceholders — chartData key repair", () => {
  it("repairs a confident near-miss (singular/plural drift) to the produced key", () => {
    const out = resolveSpecPlaceholders(
      '{"data": "$chartData:tower_markers"}',
      {},
      { tower_marker: [{ x: 1 }] }
    );
    expect(out).toBe('{"data": [{"x":1}]}');
  });

  it("leaves a genuinely hallucinated key as null (no wrong bind)", () => {
    const out = resolveSpecPlaceholders(
      '{"data": "$chartData:top_30_badge_heavy_low_contrib"}',
      {},
      { dumbbell_badge_vs_contributions: [{ a: 1 }], tier_bar: [{ b: 2 }] }
    );
    expect(out).toBe('{"data": null}');
  });

  it("does not bind when two candidates are equally plausible (ambiguous)", () => {
    const out = resolveSpecPlaceholders(
      '{"data": "$chartData:revenue"}',
      {},
      { revenue_by_region: [{ a: 1 }], revenue_by_product: [{ b: 2 }] }
    );
    expect(out).toBe('{"data": null}');
  });

  it("still resolves an exact key directly", () => {
    const out = resolveSpecPlaceholders('{"data": "$chartData:sales"}', {}, { sales: [{ n: 5 }] });
    expect(out).toBe('{"data": [{"n":5}]}');
  });
});

describe("resolveSpecPlaceholders — never leak an unresolved placeholder", () => {
  it("blanks an unresolved standalone $result value to null (not the raw token)", () => {
    const out = resolveSpecPlaceholders('{"content": "$result:step_1_title"}', {}, {});
    expect(out).toBe('{"content": null}');
    expect(out).not.toContain("$result:");
  });

  it("strips an unresolved $result placeholder embedded in prose", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "Overview of $result:step_1_title here"}',
      {},
      {}
    );
    expect(out).not.toContain("$result:");
    expect(out).toContain("Overview of");
  });

  it("resolves real keys and only sweeps the genuinely-missing ones", () => {
    const out = resolveSpecPlaceholders(
      '{"a": "$result:total", "b": "$result:missing_key"}',
      { total: 42 },
      {}
    );
    expect(out).toBe('{"a": 42, "b": null}');
  });

  it("removes a malformed key with a hyphen WHOLE — no orphaned tail leaks", () => {
    // The real bug: a key built from a data value ("on-demand") contains a hyphen.
    // The sweep must consume the entire "$result:..._on-demand_..._pct", not stop
    // at the hyphen and leave "-demand_..._pct" in the prose.
    const out = resolveSpecPlaceholders(
      '{"content": "the threshold was $result:m7i_4xlarge_on-demand_outlier_threshold_used_pct percent"}',
      {},
      {}
    );
    expect(out).not.toContain("$result:");
    expect(out).not.toMatch(/-demand/);
    expect(out).not.toContain("outlier_threshold_used_pct");
    expect(out).toContain("the threshold was");
    expect(out).toContain("percent");
  });
});

describe("$finding resolution (declared-findings spec §4.2)", () => {
  const findings = {
    churn_rate_trend: "falling",
    rate_vs_volume_split: { rate: 1317.3, volume: 203.8, dominant: "rate" },
  };

  it("resolves value-form, field paths, and inline prose bindings", () => {
    expect(
      resolveSpecPlaceholders('{"value": "$finding:churn_rate_trend"}', {}, {}, findings)
    ).toBe('{"value": "falling"}');
    expect(
      resolveSpecPlaceholders(
        '{"content": "Churn is $finding:churn_rate_trend across 2024."}',
        {},
        {},
        findings
      )
    ).toContain("Churn is falling across 2024.");
    expect(
      resolveSpecPlaceholders(
        '{"content": "driven by $finding:rate_vs_volume_split.dominant"}',
        {},
        {},
        findings
      )
    ).toContain("driven by rate");
  });

  it("object-form normalizes; bare structured inline does NOT print JSON", () => {
    expect(
      resolveSpecPlaceholders('{"value": {"$finding": "churn_rate_trend"}}', {}, {}, findings)
    ).toBe('{"value": "falling"}');
    // A structured finding without a .field path must not dump an object
    // into prose — the token is left for the sweep instead.
    const out = resolveSpecPlaceholders(
      '{"content": "split: $finding:rate_vs_volume_split done"}',
      {},
      {},
      findings
    );
    expect(out).not.toContain("1317");
  });

  it("the final sweeps strip unresolved $finding tokens instead of leaking them", () => {
    const valueForm = resolveSpecPlaceholders(
      '{"value": "$finding:ghost_metric"}',
      {},
      {},
      findings
    );
    expect(valueForm).toBe('{"value": null}');
    const inline = resolveSpecPlaceholders(
      '{"content": "it was $finding:ghost_metric overall"}',
      {},
      {},
      findings
    );
    expect(inline).not.toContain("$finding");
  });
});

describe("state-binding repair — the empty-dashboard family (run-8 PDF)", () => {
  const valid = {
    computed: new Set(["stats"]),
    datasets: new Set([
      "main",
      "monthly_churn_line",
      "segment_churn_line",
      "segment_churn_bar",
      "mom_change_bar",
      "waterfall_decomposition",
      "segment_jan_vs_dec_dumbbell",
    ]),
  };

  it("repairs every chart binding from the real broken run (cross-prefix + token subset)", () => {
    // The composer bound /computed/<short-name> in a spec with NO
    // DataController; the arrays sat under /datasets/<longer-name>.
    const cases: Array<[string, string]> = [
      ["/computed/monthly_line", "/datasets/monthly_churn_line"],
      ["/computed/seg_line", "/datasets/segment_churn_line"],
      ["/computed/seg_bar", "/datasets/segment_churn_bar"],
      ["/computed/mom_bar", "/datasets/mom_change_bar"],
      ["/computed/waterfall", "/datasets/waterfall_decomposition"],
      ["/computed/dumbbell", "/datasets/segment_jan_vs_dec_dumbbell"],
    ];
    for (const [broken, fixed] of cases) {
      const value = { props: { data: { $state: broken } } };
      const repairs = repairStateBindings(value, valid);
      expect(repairs).toBe(1);
      expect(value.props.data.$state).toBe(fixed);
    }
  });

  it("never repairs ambiguously and leaves valid bindings alone", () => {
    const ambiguous = {
      computed: new Set<string>(),
      datasets: new Set(["segment_churn_line", "segment_churn_bar"]),
    };
    // "seg" token-matches BOTH candidates → no repair (empty beats wrong).
    const v1 = { data: { $state: "/computed/seg" } };
    expect(repairStateBindings(v1, ambiguous)).toBe(0);
    expect(v1.data.$state).toBe("/computed/seg");

    const v2 = { data: { $state: "/datasets/main" } };
    expect(repairStateBindings(v2, valid)).toBe(0);
  });
});

describe("inline sentinel/boolean refusal — value-aware, at the resolver seam", () => {
  const findings = {
    heterogeneity_significant: true,
    base_effect: "none",
    anomaly: null,
    churn_direction: "rising",
  };
  const results = { base_effect: "none", flag: false };

  it("strips a boolean bound inline instead of rendering 'Yes'", () => {
    const line =
      '{"content": "Segment churn rates are $finding:heterogeneity_significant across the year."}';
    const out = resolveSpecPlaceholders(line, {}, {}, findings);
    expect(out).not.toContain("Yes");
    expect(out).not.toContain("$finding");
  });

  it("strips 'none' sentinels and nulls from prose, for findings and results", () => {
    const line =
      '{"content": "The base effect is $result:base_effect and $finding:anomaly was found; flag says $result:flag."}';
    const out = resolveSpecPlaceholders(line, results, {}, findings);
    expect(out).not.toContain("none");
    expect(out).not.toContain("null");
    expect(out).not.toContain("No");
    expect(out).not.toContain("$result");
    expect(out).not.toContain("$finding");
  });

  it("keeps meaningful words inline and booleans in whole-value form", () => {
    const inline = resolveSpecPlaceholders(
      '{"content": "Churn is $finding:churn_direction over the year."}',
      {},
      {},
      findings
    );
    expect(inline).toContain("Churn is rising over the year.");
    // Whole-value binding: a StatCard may legitimately show a boolean.
    const whole = resolveSpecPlaceholders(
      '{"value": "$finding:heterogeneity_significant"}',
      {},
      {},
      findings
    );
    expect(whole).toBe('{"value": true}');
  });
});

describe("unit-carrying inline rendering — the composer never writes unit words", () => {
  const findings = {
    churn_slope: 0.9,
    churn_rate: 12.4,
    trend: { value: 0.9, p_value: 0.01 },
    "step_2.mom_change": 1.2,
  };
  const units = {
    churn_slope: "pp",
    churn_rate: "%",
    trend: "pp",
    "step_2.mom_change": "pp",
  };

  it("appends the declared unit to bare and .value bindings (step-qualified too)", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "slope of $finding:churn_slope per month; trend $finding:trend.value overall; MoM $finding:step_2.mom_change since June"}',
      {},
      {},
      findings,
      units
    );
    expect(out).toContain("slope of 0.9 pp per month");
    expect(out).toContain("trend 0.9 pp overall");
    expect(out).toContain("MoM 1.2 pp since June");
  });

  it("attaches % without a space and leaves non-value fields unitless", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "rate of $finding:churn_rate with p = $finding:trend.p_value"}',
      {},
      {},
      findings,
      units
    );
    expect(out).toContain("rate of 12.4% with p = 0.01");
  });

  it("does not double a unit the prose already carries", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "rose $finding:churn_slope pp since June"}',
      {},
      {},
      findings,
      units
    );
    expect(out).toContain("rose 0.9 pp since June");
    expect(out).not.toContain("pp pp");
  });
});

describe("run-9 feedback fixes: sentence-level refusal, identifiers, tiny numbers", () => {
  it("drops the whole sentence on refusal — no stranded 'described as: .'", () => {
    const line =
      '{"content": "Churn rose over the year. The relationship between base size and churn rate is described as: $result:base_effect. Peak was December."}';
    const out = resolveSpecPlaceholders(line, { base_effect: "none" }, {});
    expect(out).toContain("Churn rose over the year.");
    expect(out).toContain("Peak was December.");
    expect(out).not.toContain("described as");
    expect(out).not.toContain(": .");
    expect(out).not.toContain("\u0000");
  });

  it("humanizes snake_case identifier values in prose", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "primarily driven by $finding:decomp.dominant"}',
      {},
      {},
      { decomp: { churn_volume_effect: 0.09, dominant: "churn_volume_effect" } }
    );
    expect(out).toContain("primarily driven by churn volume effect");
    expect(out).not.toContain("churn_volume_effect");
  });

  it("renders tiny magnitudes exponentially — p = 9e-7 never narrates as 0", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "significant (p = $finding:trend.p_value; slope p = $result:slope_p)"}',
      { slope_p: 2.4385585774528402e-5 },
      {},
      { trend: { direction: "rising", p_value: 9.123e-7 } }
    );
    expect(out).toContain("p = 9.12e-7");
    expect(out).toContain("slope p = 2.44e-5");
    expect(out).not.toContain("p = 0)");
  });
});

describe("$result suffix units — result-bound prose keeps its units", () => {
  it("renders _pct as % (no space) and _pp with a space", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "Self-Serve at $result:top_segment_churn_rate_pct, shifting $result:step_delta_pp in August"}',
      { top_segment_churn_rate_pct: 9.59, step_delta_pp: 4.4 },
      {}
    );
    expect(out).toContain("Self-Serve at 9.59%");
    expect(out).toContain("shifting 4.4 pp in August");
  });

  it("does not double a unit the prose already carries", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "Spread is $result:spread_pct% of revenue; rose $result:rise_pp pp"}',
      { spread_pct: 23.4, rise_pp: 1.2 },
      {}
    );
    expect(out).toContain("Spread is 23.4% of revenue");
    expect(out).toContain("rose 1.2 pp");
    expect(out).not.toContain("pp pp");
    expect(out).not.toContain("%%");
  });
});

describe("unit guard — nearby unit words suppress appending (run-12 grammar bug)", () => {
  const findings = { peak_quarterly_cases: { quarter: "2021Q2", value: 53379480 } };
  const units = { peak_quarterly_cases: "cases" };

  it("does not produce 'cases total cases' when the unit appears a few words ahead", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "The highest-burden quarter was 2021Q2, with $finding:peak_quarterly_cases.value total cases."}',
      {},
      {},
      findings,
      units
    );
    expect(out).toContain("with 53379480 total cases.");
    expect(out).not.toContain("cases total cases");
  });

  it("still appends when no unit word is nearby", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "peaked at $finding:peak_quarterly_cases.value in Q2."}',
      {},
      {},
      findings,
      units
    );
    expect(out).toContain("peaked at 53379480 cases in Q2.");
  });
});
