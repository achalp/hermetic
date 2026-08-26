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

  // Run 9c415dc8: "with address strings sorted into location types via " —
  // the planner bound a 62-leaf dict, the renderer refused it, the sweep
  // took the token and left the preposition hanging at the string's end.
  it("trims the function word a stripped token leaves dangling", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "with address strings sorted into location types via $result:matched_addresses_by_location"}',
      {},
      {}
    );
    expect(out).not.toContain("$result:");
    expect(out).not.toMatch(/via\s*"/);
    expect(out).toContain("sorted into location types");
    // Mid-paragraph: the orphan sits before a period, not a quote.
    const mid = resolveSpecPlaceholders(
      '{"content": "spend was drawn from $result:ghost_breakdown. The rest held steady."}',
      {},
      {}
    );
    expect(mid).not.toMatch(/from\s*\./);
    expect(mid).toContain("The rest held steady.");
    // Prose WITHOUT a strip is never touched, even if oddly phrased.
    const untouched = resolveSpecPlaceholders('{"content": "what it adds up to."}', {}, {});
    expect(untouched).toContain("what it adds up to.");
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
    // A small structured finding inline renders as PROSE ("rate: 1317, ...")
    // — never as JSON syntax (run-26: refusing it left a caveat sentence
    // truncated mid-thought while the values sat in the manifest).
    const out = resolveSpecPlaceholders(
      '{"content": "split: $finding:rate_vs_volume_split done"}',
      {},
      {},
      findings
    );
    expect(out).toContain("split: rate: 1317.3, volume: 203.8, dominant: rate done");
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

  // Two real runs, two opposite failures out of the same branch:
  //   77051c9d — an 11-entry group_ns swept to "", leaving "…spanning group
  //     sizes of " hanging mid-clause.
  //   f47eb42d — routing that case through REFUSAL_MARKER instead deleted the
  //     whole sentence, and because these nodes are often ONE sentence it
  //     deleted the node: that run shipped an EMPTY ANSWER (shares_pct, an
  //     11-entry map) and an empty trend EXPLAIN (slope_ci95, a 2-element
  //     array).
  // A missing answer is worse than an ugly clause, so the marker route is
  // reverted and this pins the safer of the two. Both are workarounds — these
  // values are ordinary English and belong in the value renderer
  // (specs/finding-field-roles-2026-08-13.md), which supersedes this test.
  it("keeps the surrounding sentence when an oversized dict cannot render inline", () => {
    const groupNs = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`group_${i}`, i + 1]));
    const line =
      '{"content": "Categories differ by more than chance, spanning group sizes of $finding:segment_heterogeneity.group_ns. The largest single charge was elsewhere."}';
    const out = resolveSpecPlaceholders(
      line,
      {},
      {},
      { segment_heterogeneity: { group_ns: groupNs } }
    );
    // The token never leaks...
    expect(out).not.toContain("$finding");
    // ...but neither sentence is deleted — a node that is one sentence must
    // not become an empty node.
    expect(out).toContain("Categories differ by more than chance");
    expect(out).toContain("The largest single charge was elsewhere.");
  });

  // The f47eb42d shape reduced: a single-sentence node whose only defect is an
  // unrenderable binding must still render prose.
  it("never empties a single-sentence node over an unrenderable binding", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "Daily spend moved in a $finding:t.direction direction, with a confidence interval of $finding:t.slope_ci95."}',
      {},
      {},
      { t: { direction: "flat", slope_ci95: [-11.15, 11.51] } }
    );
    expect(out).toContain("Daily spend moved in a flat direction");
    expect(out).not.toContain("$finding");
    expect(out).not.toMatch(/"content":\s*""/);
  });

  it("renders a small numeric mapping as ranked prose (value renderer)", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "The split was $finding:weekday_weekend_spend_share.shares_pct overall."}',
      {},
      {},
      { weekday_weekend_spend_share: { shares_pct: { weekday: 87.1, weekend: 12.9 } } }
    );
    // "k at v" prose, ranked, with the _pct key-name convention supplying %.
    expect(out).toContain("weekday at 87.1% and weekend at 12.9%");
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

  it("renders a declared-usd $result with currency precision + grouping (LOW fix)", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "Revenue was $result:total_revenue and margin $result:avg_margin."}',
      { total_revenue: 1138.4, avg_margin: 37.2759 },
      {},
      {},
      {},
      { total_revenue: "usd", avg_margin: "usd" }
    );
    // 2dp + thousands grouping, not the generic float path's false precision.
    expect(out).toContain("1,138.40");
    expect(out).toContain("37.28");
    expect(out).not.toContain("37.2759");
  });
});

describe("$series alias + declared units (analysis-product spec §2)", () => {
  it("$series:<id> resolves through the synthesized chartData view, all three forms", () => {
    const rows = [{ yr: 2000, v: 1 }];
    const stringForm = resolveSpecPlaceholders(
      '{"data": "$series:annual_prices"}',
      {},
      { annual_prices: rows }
    );
    expect(JSON.parse(stringForm)).toEqual({ data: rows });
    const objectForm = resolveSpecPlaceholders(
      '{"data": {"$series": "annual_prices"}}',
      {},
      { annual_prices: rows }
    );
    expect(JSON.parse(objectForm)).toEqual({ data: rows });
    const nested = resolveSpecPlaceholders(
      '{"z": "$series:heat.z"}',
      {},
      { heat: { z: [[1, 2]] } }
    );
    expect(JSON.parse(nested)).toEqual({ z: [[1, 2]] });
  });

  it("declared units beat key-name morphology; convention still the fallback", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "Median $result:median_price over $result:coverage_pct of menus"}',
      { median_price: 24.5, coverage_pct: 61.2 },
      {},
      {},
      {},
      { median_price: "usd" } // declared via declare_value(unit="usd")
    );
    // usd → currency precision (2dp); the declared unit wins over morphology.
    expect(out).toContain("Median $24.50"); // currency renders with the symbol, not a "usd" suffix
    expect(out).toContain("61.2% of menus"); // _pct fallback untouched
  });

  it("a declared unit overrides a misleading suffix on the same key", () => {
    // declare_value(key="growth_pct", unit="pp") — declaration wins.
    const out = resolveSpecPlaceholders(
      '{"content": "grew $result:growth_pct since 1900"}',
      { growth_pct: 3.1 },
      {},
      {},
      {},
      { growth_pct: "pp" }
    );
    expect(out).toContain("grew 3.1 pp since 1900");
    expect(out).not.toContain("3.1%");
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

describe("anaphora-aware refusal stripping (run-13: 'This exceeded...')", () => {
  it("drops a This/It sentence that followed a stripped null-detection sentence", () => {
    const findings = {
      cases_step_change: { period: null, delta: null, direction: null, baseline_spread: 3056244.5 },
    };
    const line =
      '{"content": "The largest monthly jump was $finding:cases_step_change.delta cases in $finding:cases_step_change.period. This exceeded the baseline monthly fluctuation spread of $finding:cases_step_change.baseline_spread cases. Waves remained the dominant pattern."}';
    const out = resolveSpecPlaceholders(line, {}, {}, findings);
    expect(out).not.toContain("exceeded the baseline");
    expect(out).not.toContain("largest monthly jump");
    expect(out).toContain("Waves remained the dominant pattern.");
  });

  it("keeps an anaphoric sentence when nothing before it was stripped", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "Cases rose to $result:total. This exceeded expectations."}',
      { total: 500 },
      {},
      {}
    );
    expect(out).toContain("This exceeded expectations.");
  });
});

describe("field-name units — pct_from_peak renders with % (run-15 leak)", () => {
  it("appends % for pct_-prefixed finding fields and _pct results", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "ends $finding:cases_current_state.pct_from_peak from that peak; spread $result:spread_pct of total"}',
      { spread_pct: 23.4 },
      {},
      { cases_current_state: { period: "2021-10", value: 8694867, pct_from_peak: -61.44 } }
    );
    expect(out).toContain("ends -61.44% from that peak");
    expect(out).toContain("spread 23.4% of total");
  });

  it("declared finding unit still wins over the field-name convention", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "slope $finding:churn_slope.value overall"}',
      {},
      {},
      { churn_slope: { value: 0.9 } },
      { churn_slope: "pp" }
    );
    expect(out).toContain("slope 0.9 pp overall");
  });
});

describe("inline value rendering — the vanished caveat (run-26) and the value renderer", () => {
  it("renders a flat mapping as ranked prose instead of sweeping it to nothing", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "Thin decades flagged by the analysis: $finding:thin_decades.value."}',
      {},
      {},
      { thin_decades: { value: { "2010s": 2, "1870s": 1 } } }
    );
    expect(out).toContain("Thin decades flagged by the analysis: 2010s at 2 and 1870s at 1.");
  });

  it("renders a LARGE numeric mapping ranked with the minimum surfaced", () => {
    // 77051c9d's group_ns shape: 11 groups, the thin ones (n = 2) are the
    // point of the disclosure — the renderer names the minimum, so "8
    // others" can never hide the n = 2 group the caveat is about.
    const out = resolveSpecPlaceholders(
      '{"content": "Group sizes: $finding:het.group_ns."}',
      {},
      {},
      {
        het: {
          group_ns: {
            Other: 45,
            "Online Shopping": 18,
            Groceries: 15,
            Dining: 12,
            Coffee: 9,
            Gas: 8,
            Retail: 7,
            Healthcare: 6,
            Parking: 5,
            Membership: 3,
            Utilities: 2,
          },
        },
      }
    );
    expect(out).toContain("Other at 45, Online Shopping at 18, Groceries at 15");
    expect(out).toContain("down to Utilities at 2");
    expect(out).toContain("with 7 more in between");
    expect(out).not.toContain("$finding");
  });

  it("renders a 2-element numeric array as an interval", () => {
    // f47eb42d's slope_ci95 — refusing this emptied a whole EXPLAIN node.
    const out = resolveSpecPlaceholders(
      '{"content": "with a confidence interval of $finding:t.slope_ci95, the trend holds."}',
      {},
      {},
      { t: { slope_ci95: [-11.152661322587706, 11.50571865863085] } }
    );
    expect(out).toContain("-11.1527 to 11.5057");
    expect(out).toContain("the trend holds.");
  });

  it("renders a short scalar sequence as a list", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "Excluded years: $finding:s.excluded."}',
      {},
      {},
      { s: { excluded: [1966, 1972, 1981] } }
    );
    expect(out).toContain("Excluded years: 1966, 1972 and 1981.");
  });

  it("still refuses genuinely unspeakable values without deleting the sentence", () => {
    const nested = resolveSpecPlaceholders(
      '{"content": "Shape: $finding:n.value here. After."}',
      {},
      {},
      { n: { value: { a: { b: 1 } } } }
    );
    expect(nested).not.toContain("[object");
    expect(nested).not.toContain("$finding");
    // The sentence survives, token-stripped — never deleted (run f47eb42d).
    expect(nested).toContain("Shape:");
    expect(nested).toContain("After.");
  });
});

describe("repairMetricBindings — bind the metric the prose names (run-41 root fix)", () => {
  const results = {
    median_price_slope_per_period: 0.1092,
    iqr_price_slope_per_period: 0.0889,
    median_price_trend_p_value: 6.59e-11,
  };

  it("repairs the wrong-family binding in a median-subject sentence", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "The median price series is rising over the full priced period (OLS slope $result:iqr_price_slope_per_period per year, p = $result:median_price_trend_p_value)."}',
      results,
      {}
    );
    expect(out).toContain("0.1092");
    expect(out).not.toContain("0.0889");
  });

  it("does not repair when the prose names the binding's own family, or names two families", () => {
    const iqrSentence = resolveSpecPlaceholders(
      '{"content": "The IQR widened at $result:iqr_price_slope_per_period per year over the period."}',
      results,
      {}
    );
    expect(iqrSentence).toContain("0.0889");
    const both = resolveSpecPlaceholders(
      '{"content": "The median rose faster than the IQR widened, at $result:iqr_price_slope_per_period per year overall."}',
      results,
      {}
    );
    expect(both).toContain("0.0889");
  });

  it("does not invent keys — no sibling, no repair", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "The median moved at $result:spread_velocity per year across decades."}',
      { spread_velocity: 3.2 },
      {}
    );
    expect(out).toContain("3.2");
  });

  // finding H6: a contrast sentence names one extreme in prose and binds the
  // OTHER — the swap must NOT fire (it rendered the opposite statistic).
  it("does not swap min↔max across a contrast conjunction (finding H6)", () => {
    const results = { min_close: 11.2, max_close: 98.7 };
    const out = resolveSpecPlaceholders(
      '{"content": "The daily max held steady while $result:min_close drifted lower."}',
      results,
      {}
    );
    expect(out).toContain("11.2"); // the minimum, as bound
    expect(out).not.toContain("98.7"); // NOT rewritten to the maximum
  });

  it("does not swap p25↔p75 across 'whereas' (finding H6)", () => {
    const results = { p25_wait: 4, p75_wait: 40 };
    const out = resolveSpecPlaceholders(
      '{"content": "The p75 wait blew out, whereas $result:p25_wait barely moved."}',
      results,
      {}
    );
    expect(out).toContain("4");
    expect(out).not.toContain("40");
  });

  it("still repairs a same-clause mis-binding the prose directly names", () => {
    const results = { min_close: 11.2, max_close: 98.7 };
    const out = resolveSpecPlaceholders(
      '{"content": "The max close was $result:min_close over the window."}',
      results,
      {}
    );
    expect(out).toContain("98.7"); // prose names max, binding repaired to max_close
  });

  it("segment-matches families — 'min' does not match an incidental substring", () => {
    // key `nominal_value` contains the substring "min" but not as a segment;
    // prose names "max", so the old substring match would have swapped it to
    // the existing sibling `nomaxal_value` (0.1) — the segment match must not.
    const results = { nominal_value: 7.7, nomaxal_value: 0.1 };
    const out = resolveSpecPlaceholders(
      '{"content": "The max estimate was $result:nominal_value overall."}',
      results,
      {}
    );
    expect(out).toContain("7.7");
    expect(out).not.toContain("0.1");
  });
});

// Run 77051c9d narrated a credit-card statement with "1138.4 usd", "37.2759"
// and "16.635": parseFloat(toFixed(4)).toString() is unit-blind, so it drops
// the cent and the thousands separator and money reads as a float dump.
describe("currency bindings render as money", () => {
  const findings = {
    top_spending_category: { value: 1138.4, n: 45 },
    spend_distribution: { mean: 37.2759, median: 16.635, skew: 7.64, n: 130 },
    daily_spend_trend: { slope_per_period: 0.17652866, p_value: 0.9758887 },
  };
  const units = {
    top_spending_category: "usd",
    spend_distribution: "usd",
    daily_spend_trend: "usd",
  };

  it("gives a currency main value 2dp and thousands separators", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "Top category totalled $finding:top_spending_category.value."}',
      {},
      {},
      findings,
      units
    );
    expect(out).toContain("1,138.40");
    expect(out).not.toContain("1138.4 ");
  });

  it("carries the unit onto fields that ARE the measure", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "Mean $finding:spend_distribution.mean against median $finding:spend_distribution.median."}',
      {},
      {},
      findings,
      units
    );
    expect(out).toContain("37.28");
    expect(out).toContain("16.64");
    expect(out).not.toContain("37.2759");
  });

  it("leaves unitless fields of a currency finding alone", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "Skew $finding:spend_distribution.skew over $finding:spend_distribution.n rows, p $finding:daily_spend_trend.p_value."}',
      {},
      {},
      findings,
      units
    );
    // Not money: no 2dp coercion, no currency word, full p-value precision.
    expect(out).toContain("7.64");
    expect(out).toContain("130");
    expect(out).toContain("0.9759");
    expect(out).not.toContain("7.64 usd");
    expect(out).not.toContain("130.00");
  });

  it("does not touch non-currency units", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "Churn ended at $finding:churn.value."}',
      {},
      {},
      { churn: { value: 13.08198 } },
      { churn: "pp" }
    );
    expect(out).toContain("13.082");
    expect(out).not.toContain("13.08 ");
  });
});

describe("step-qualified finding FIELD paths (L3 backlog #2)", () => {
  // Investigate merges per-step findings under dotted TOP-LEVEL keys
  // ("step_2.churn_trend"). A first-dot-only split resolved the bare name
  // but never a field beneath it — resolveKeyPath must try the LONGEST
  // dotted prefix as a single key first.
  const findings = {
    "step_2.churn_trend": { direction: "falling", slope: -0.4, p_value: 0.003 },
    "step_2.mom_change": 1.2,
    "significant_at_0.05": true,
    trend: { p_value: 0.01 },
  };

  it("resolves $finding:step_2.churn_trend.direction (key at the SECOND dot)", () => {
    const out = resolveSpecPlaceholders(
      '{"content": "Churn is $finding:step_2.churn_trend.direction over H2."}',
      {},
      {},
      findings
    );
    expect(out).toContain("Churn is falling over H2.");
  });

  it("value-form field path under a step-qualified key resolves too", () => {
    expect(
      resolveSpecPlaceholders('{"value": "$finding:step_2.churn_trend.slope"}', {}, {}, findings)
    ).toBe('{"value": -0.4}');
  });

  it("keys with literal dots still resolve whole ($finding + $result parity)", () => {
    expect(
      resolveSpecPlaceholders('{"value": "$finding:significant_at_0.05"}', {}, {}, findings)
    ).toBe('{"value": true}');
    expect(
      resolveSpecPlaceholders(
        '{"value": "$result:significant_at_0.05"}',
        { "significant_at_0.05": true },
        {}
      )
    ).toBe('{"value": true}');
  });

  it("falls back to a shorter prefix when the longer key lacks the field", () => {
    // The longest dotted prefix ("a.b") exists but misses the tail; the
    // shorter split (a → b → c) resolves — greedy must not stop at the
    // first prefix hit.
    const layered = { "a.b": { other: 2 }, a: { b: { c: 1 } } };
    expect(resolveSpecPlaceholders('{"value": "$finding:a.b.c"}', {}, {}, layered)).toBe(
      '{"value": 1}'
    );
  });
});
