import { describe, it, expect } from "vitest";
import {
  validatePlan,
  defaultPlan,
  nextPlanNodeId,
  planBudget,
  PLAN_OPS,
} from "@/lib/compose/plan";
import { buildPlannerSystem } from "@/lib/compose/planner";
import { deriveViews } from "@/lib/compose/views";
import { realizeClaim, realizeNode } from "@/lib/compose/realizer";
import { applyMutations } from "@/lib/compose/mutations";
import { compileDashboard } from "@/lib/compose/compile";
import { componentForSeries } from "@/lib/compose/scaffold";
import type { FindingEntry, FindingsManifest } from "@/lib/contracts/findings";
import type { PlanDocument } from "@/lib/contracts/plan";
import type { AnalysisProduct } from "@/lib/contracts/product";

const F = (name: string, dtype: string, value: unknown, extra: Partial<FindingEntry> = {}) =>
  ({
    name,
    dtype,
    definition: `${name} over the observed period`,
    value,
    ...extra,
  }) as FindingEntry;

const FINDINGS: FindingEntry[] = [
  F("price_trend", "direction", {
    direction: "rising",
    slope_per_period: 0.0616,
    p_value: 1.9e-12,
    slope_ci95: [0.0465, 0.0767],
  }),
  F("price_peak", "superlative", {
    period: "1998",
    value: 10,
    n: 731,
    raw_period: "2012",
    raw_value: 26,
    raw_n: 382,
    thin_periods_skipped: 47,
    thin_bar: 635.1,
  }),
  F("price_current_state", "current_state", {
    period: 1998,
    value: 10,
    pct_from_peak: 0,
    excluded_trailing: 9,
    excluded_reason: "attestation",
    latest_period: 2012,
    latest_value: 26,
    latest_n: 382,
  }),
  F("zero_screen", "check", {
    passed: false,
    evidence: { n_excluded: 12, zero_share: 0.09 },
  }),
];

const MANIFEST: FindingsManifest = {
  manifest_version: "1",
  findings: FINDINGS,
} as FindingsManifest;

const PRODUCT: AnalysisProduct = {
  series: [
    {
      id: "annual_prices",
      rows: [{ year: 1900, median: 0.3, median_raw: 0.3, n: 5000 }],
      roles: {
        x: { column: "year", kind: "temporal" },
        measures: [
          { column: "median", unit: "usd", screened_by: "zero_screen", variant_of: "median_raw" },
        ],
        count: { column: "n" },
      },
    },
  ],
  values: [],
};

describe("validatePlan — structural invariants as parse errors", () => {
  it("requires exactly one ANSWER (no-narrative is unrepresentable)", () => {
    const v = validatePlan({ nodes: [{ id: "a", op: "NOTE", refs: ["price_trend"] }] }, FINDINGS);
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain("ANSWER");
  });

  it("CAVEAT may only reference checks — a fabricated mechanism has no syntax", () => {
    const v = validatePlan(
      {
        nodes: [
          { id: "a", op: "ANSWER", refs: ["price_trend"] },
          { id: "b", op: "CAVEAT", refs: ["price_peak"] },
        ],
      },
      FINDINGS
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain("checks/screens");
    // Free text off INSIGHT is also unrepresentable.
    const v2 = validatePlan(
      {
        nodes: [
          { id: "a", op: "ANSWER", refs: ["price_trend"] },
          { id: "b", op: "CAVEAT", refs: ["zero_screen"], text: "currency coverage collapsed" },
        ],
      },
      FINDINGS
    );
    expect(v2.ok).toBe(false);
    expect(v2.errors.join()).toContain("INSIGHT");
  });

  it("accepts a valid plan; dangling refs rejected", () => {
    const ok = validatePlan(
      {
        nodes: [
          { id: "a", op: "ANSWER", refs: ["price_trend"] },
          { id: "b", op: "CAVEAT", refs: ["zero_screen"] },
        ],
      },
      FINDINGS
    );
    expect(ok.ok).toBe(true);
    const bad = validatePlan({ nodes: [{ id: "a", op: "ANSWER", refs: ["ghost"] }] }, FINDINGS);
    expect(bad.ok).toBe(false);
  });

  it("defaultPlan always validates (the compiled pipeline cannot fail)", () => {
    const p = defaultPlan(FINDINGS);
    expect(validatePlan(p, FINDINGS).ok).toBe(true);
  });

  it("plan budgets scale with purpose; the planner prompt carries them", () => {
    // The observed gap: a compiled deep-dive computed deep-dive-sized
    // findings, then told a dashboard-sized (4-9 node) story.
    expect(planBudget("brief").maxNodes).toBeLessThan(planBudget("dashboard").maxNodes);
    expect(planBudget("report").maxNodes).toBeGreaterThan(planBudget("dashboard").maxNodes);
    expect(planBudget("deep-dive").maxNodes).toBeGreaterThan(planBudget("report").maxNodes);
    // Legacy alias + unknown resolve through the same table as every consumer.
    expect(planBudget("executive-summary").maxNodes).toBe(planBudget("brief").maxNodes);
    expect(planBudget(undefined).maxNodes).toBe(planBudget("dashboard").maxNodes);
    expect(buildPlannerSystem("deep-dive")).toContain("10-20 nodes");
    expect(buildPlannerSystem("deep-dive")).toContain("EVERY non-check claim");
    expect(buildPlannerSystem()).toContain("4-9 nodes");
  });

  it("defaultPlan fills to the purpose budget; caveats never cut", () => {
    const deep = defaultPlan(FINDINGS, "deep-dive");
    expect(validatePlan(deep, FINDINGS).ok).toBe(true);
    // All three non-check claims narrated (ANSWER + PEAK + ENDPOINT) + caveat.
    const refs = deep.nodes.flatMap((n) => n.refs);
    expect(refs).toContain("price_peak");
    expect(refs).toContain("price_current_state");
    expect(deep.nodes.some((n) => n.op === "CAVEAT")).toBe(true);
    // Brief keeps the caveat even at its tight budget.
    const brief = defaultPlan(FINDINGS, "brief");
    expect(brief.nodes.some((n) => n.op === "CAVEAT")).toBe(true);
    expect(brief.nodes.length).toBeLessThanOrEqual(5);
  });
});

describe("view catalog — deterministic derivation from roles + regimes", () => {
  const SERIES = PRODUCT.series[0]; // annual_prices: median(usd)/median_raw + count n

  it("primary keeps its stable id; coverage and table exist unshipped by default", () => {
    const views = deriveViews({ series: [SERIES] });
    const byId = new Map(views.map((v) => [v.id, v]));
    expect(byId.get("chart_annual_prices")?.shipped).toBe(true);
    expect(byId.get("chart_annual_prices__counts")?.shipped).toBe(false);
    expect(byId.get("table_annual_prices")?.shipped).toBe(false);
  });

  it("thin-data regimes force the coverage companion for every purpose", () => {
    const views = deriveViews({
      series: [SERIES],
      regimes: { annual_prices: { flags: ["COUNT_SKEWED", "THIN_EDGE"] } },
      purpose: "brief",
    });
    const cov = views.find((v) => v.kind === "coverage");
    expect(cov?.shipped).toBe(true);
    expect(cov?.reason).toContain("COUNT_SKEWED");
    const patch = cov!.patch.value as { type: string; props: { y_keys: string[] } };
    expect(patch.type).toBe("BarChart");
    expect(patch.props.y_keys).toEqual(["n"]);
  });

  it("deep-dive ships coverage + table; report ships the table", () => {
    const deep = deriveViews({ series: [SERIES], purpose: "deep-dive" });
    expect(deep.find((v) => v.kind === "coverage")?.shipped).toBe(true);
    expect(deep.find((v) => v.kind === "table")?.shipped).toBe(true);
    const report = deriveViews({ series: [SERIES], purpose: "report" });
    expect(report.find((v) => v.kind === "table")?.shipped).toBe(true);
    expect(report.find((v) => v.kind === "coverage")?.shipped).toBe(false);
  });

  it("mixed units split into separate charts — never one y axis", () => {
    const mixed = {
      ...SERIES,
      roles: {
        ...SERIES.roles,
        measures: [
          { column: "median", unit: "usd" },
          { column: "n_items", unit: "count" },
        ],
      },
    };
    const views = deriveViews({ series: [mixed] });
    const primary = views.find((v) => v.kind === "primary")!;
    const split = views.find((v) => v.kind === "unit_split")!;
    expect((primary.patch.value as { props: { y_keys: string[] } }).props.y_keys).toEqual([
      "median",
    ]);
    expect(split.shipped).toBe(true);
    expect((split.patch.value as { props: { y_keys: string[] } }).props.y_keys).toEqual([
      "n_items",
    ]);
  });
});

describe("realizer — honesty clauses live IN the templates", () => {
  it("every claim dtype in the taxonomy has a dedicated template (exhaustiveness)", () => {
    // A taxonomy dtype falling through to the generic template would render
    // "<label> — <definition>: $finding:<name>." — assert none do.
    const samples: Array<[string, unknown]> = [
      ["direction", { direction: "rising", slope_per_period: 1, p_value: 0.01 }],
      ["superlative", { period: "x", value: 1, n: 5 }],
      ["current_state", { period: "x", value: 1, pct_from_peak: -5 }],
      [
        "comparison",
        { early_median: 1, late_median: 2, multiplier: 2, early_span: "a", late_span: "b" },
      ],
      ["step_change", { period: "x", delta: 1, direction: "up", baseline_spread: 0.1 }],
      ["distribution", { median: 1, mean: 2, skew: 3 }],
      [
        "correlation",
        { pearson_r: 0.5, pearson_p: 0.01, spearman_rho: 0.4, spearman_p: 0.02, n: 10 },
      ],
      ["share", { shares_pct: {}, residual_pct: 1 }],
      ["check", { passed: true, evidence: {} }],
      ["screen", { passed: false, evidence: { n_flagged: 2 } }],
    ];
    for (const [dtype, value] of samples) {
      const text = realizeClaim(F(`claim_${dtype}`, dtype, value));
      expect(text, dtype).not.toContain("over the observed period:");
    }
  });

  it("superlative renders the raw extreme beside the attested value", () => {
    const text = realizeClaim(FINDINGS[1]);
    expect(text).toContain("$finding:price_peak.value");
    expect(text).toContain("$finding:price_peak.raw_value");
    expect(text).toContain("$finding:price_peak.thin_bar");
  });

  it("current_state binds excluded_reason and latest_* — mechanisms cannot be invented", () => {
    const text = realizeClaim(FINDINGS[2]);
    expect(text).toContain("$finding:price_current_state.excluded_reason");
    expect(text).toContain("$finding:price_current_state.latest_value");
  });

  it("trend renders the CI beside the slope", () => {
    const text = realizeClaim(FINDINGS[0]);
    expect(text).toContain("slope_ci95.0");
    expect(text).toContain("$finding:price_trend.p_value");
  });

  it("renders n_zero_excluded when the claim-layer zero screen fired, silent otherwise", () => {
    // Claim-layer totalization (regime-matrix amendment): a policy the
    // helper applied must be visible in the sentence it produced.
    const screened = realizeClaim(
      F("price_trend_z", "trend", {
        direction: "rising",
        slope_per_period: 1,
        p_value: 0.01,
        n_zero_excluded: 12,
      })
    );
    expect(screened).toContain("$finding:price_trend_z.n_zero_excluded");
    expect(screened).toContain("unrecorded-value sentinels");
    // n_zero_excluded 0 (or absent — pre-totalization payloads) adds nothing.
    const clean = realizeClaim(
      F("price_trend_c", "trend", {
        direction: "rising",
        slope_per_period: 1,
        p_value: 0.01,
        n_zero_excluded: 0,
      })
    );
    expect(clean).not.toContain("n_zero_excluded");
    expect(realizeClaim(FINDINGS[0])).not.toContain("n_zero_excluded");
    // The clause spans the unit=-threaded templates, not just trend.
    const sup = realizeClaim(
      F("peak_z", "superlative", { period: "x", value: 1, n: 5, n_zero_excluded: 3 })
    );
    expect(sup).toContain("$finding:peak_z.n_zero_excluded");
    const dist = realizeClaim(
      F("dist_z", "distribution", { median: 1, mean: 2, skew: 3, n_zero_excluded: 2 })
    );
    expect(dist).toContain("$finding:dist_z.n_zero_excluded");
  });

  it("renders the weighted-fit and preferred-coefficient dispatches when present", () => {
    const wls = realizeClaim(
      F("price_trend_w", "trend", {
        direction: "flat",
        slope_per_period: 0.03,
        p_value: 0.92,
        weighted: true,
      })
    );
    expect(wls).toContain("(count-weighted fit)");
    expect(realizeClaim(FINDINGS[0])).not.toContain("count-weighted");
    const corr = realizeClaim(
      F("price_vs_n", "correlation", {
        pearson_r: 0.5,
        pearson_p: 0.01,
        spearman_rho: 0.7,
        spearman_p: 0.001,
        n: 40,
        preferred: "spearman",
      })
    );
    expect(corr).toContain("$finding:price_vs_n.preferred");
  });

  it("checks render definition + scalar evidence bindings, never booleans inline", () => {
    const text = realizeClaim(FINDINGS[3]);
    expect(text).toContain("⚠ FAILED");
    expect(text).toContain("$finding:zero_screen.evidence.n_excluded");
    expect(text).not.toContain("$finding:zero_screen.passed");
  });

  it("INSIGHT nodes pass their text through; empty nodes render null", () => {
    const byName = new Map(FINDINGS.map((f) => [f.name, f]));
    expect(realizeNode({ id: "i", op: "INSIGHT", refs: [], text: "Synthesis." }, byName)).toBe(
      "Synthesis."
    );
    expect(realizeNode({ id: "x", op: "NOTE", refs: ["ghost"] }, byName)).toBeNull();
  });
});

describe("compileDashboard — deterministic, identity-keyed, overlay-aware", () => {
  const plan = {
    nodes: [
      { id: "n_answer", op: "ANSWER" as const, refs: ["price_trend"] },
      { id: "n_peak", op: "PEAK" as const, refs: ["price_peak"] },
      { id: "n_caveat", op: "CAVEAT" as const, refs: ["zero_screen"] },
    ],
  };
  const input = {
    manifest: MANIFEST,
    product: PRODUCT,
    plan,
    overlay: {},
    headlinePlan: [{ binding: "$finding:price_peak.value", label: "Peak", reason: "peak" }],
    question: "How have prices changed?",
  };

  it("compiles banner + tiles + narrative + charts + root, byte-deterministic", () => {
    const lines = compileDashboard(input);
    const again = compileDashboard(input);
    expect(lines).toEqual(again); // same input, same bytes
    const joined = lines.join("\n");
    expect(joined).toContain("compiled_check_banner"); // failed check first
    expect(joined).toContain('"tile_0"');
    expect(joined).toContain("/elements/n_answer");
    expect(joined).toContain("chart_annual_prices");
    // Chart carries screened measure AND its raw sibling.
    expect(joined).toContain('"median","median_raw"');
    expect(lines[lines.length - 1]).toContain('"compiled_root"');
  });

  it("purpose + regimes govern the shipped view family; overlay can hide any view", () => {
    const flagged = {
      ...input,
      purpose: "report",
      regimes: { annual_prices: { flags: ["THIN_PERIODS"] } },
    };
    const joined = compileDashboard(flagged).join("\n");
    expect(joined).toContain("chart_annual_prices__counts"); // regime-forced evidence
    expect(joined).toContain("table_annual_prices"); // document style
    // Dashboard default with no flags ships neither — byte-compatible depth.
    const plain = compileDashboard(input).join("\n");
    expect(plain).not.toContain("__counts");
    expect(plain).not.toContain("table_annual_prices");
    // The overlay grammar governs views like every other element.
    const hiddenCov = compileDashboard({
      ...flagged,
      overlay: { hidden: ["chart_annual_prices__counts"] },
    }).join("\n");
    expect(hiddenCov).not.toContain("__counts");
  });

  it("overlay hides and reorders by stable id, surviving recompiles", () => {
    const lines = compileDashboard({
      ...input,
      overlay: { hidden: ["n_peak"], order: ["chart_annual_prices", "n_answer"] },
    });
    const joined = lines.join("\n");
    expect(joined).not.toContain("/elements/n_peak");
    const root = JSON.parse(lines[lines.length - 2]) as { value: { children: string[] } };
    expect(root.value.children[0]).toBe("chart_annual_prices");
  });

  it("temporal x compiles to LineChart, categorical to BarChart", () => {
    expect(componentForSeries(PRODUCT.series[0])).toBe("LineChart");
    expect(
      componentForSeries({
        ...PRODUCT.series[0],
        roles: { ...PRODUCT.series[0].roles, x: { column: "cuisine", kind: "categorical" } },
      })
    ).toBe("BarChart");
  });
});

describe("mutations — one governed edit channel", () => {
  const doc: PlanDocument = {
    mode: "compiled",
    plan: {
      nodes: [
        { id: "a", op: "ANSWER", refs: ["price_trend"] },
        { id: "b", op: "PEAK", refs: ["price_peak"] },
      ],
    },
    overlay: {},
  };

  it("move/hide/add/remove/set_insight round-trip and re-validate", () => {
    const r1 = applyMutations(doc, [
      { kind: "move", id: "b", before: "a" },
      { kind: "hide", id: "b" },
      { kind: "set_insight", text: "The rise concentrates after 1950." },
      { kind: "add_node", node: { op: "CAVEAT", refs: ["zero_screen"] } },
    ]);
    expect(r1.errors).toEqual([]);
    expect(r1.applied).toBe(4);
    expect(r1.doc.overlay.order![0]).toBe("b");
    expect(r1.doc.overlay.hidden).toContain("b");
    expect(validatePlan(r1.doc.plan, FINDINGS).ok).toBe(true);
    // Original untouched (pure).
    expect(doc.plan.nodes).toHaveLength(2);
    const r2 = applyMutations(r1.doc, [{ kind: "remove_node", id: "zzz" }]);
    expect(r2.errors[0]).toContain("unknown node");
  });

  it("unique ids for added nodes", () => {
    const ids = new Set([nextPlanNodeId(), nextPlanNodeId(), nextPlanNodeId()]);
    expect(ids.size).toBe(3);
    expect(PLAN_OPS).toContain("INSIGHT");
  });
});
