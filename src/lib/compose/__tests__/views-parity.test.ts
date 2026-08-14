/**
 * VIEW plan op — P1 of compiled-view-parity (spec §2/§3): the planner
 * requests any licensed component; validation is blocking, salvage drops
 * only the offender, props are compiled from declared roles/claims, and a
 * compiled VIEW suppresses its series' derived primary (disclosure
 * variants survive).
 */
import { describe, it, expect } from "vitest";
import type { FindingEntry, FindingsManifest } from "@/lib/contracts/findings";
import type { SeriesEntry } from "@/lib/contracts/product";
import { validatePlan, salvagePlan } from "@/lib/compose/plan";
import { compileViewNode } from "@/lib/compose/view-compilers";
import { compileDashboard } from "@/lib/compose/compile";
import { buildPlannerSystem, buildViewCatalog } from "@/lib/compose/planner";

const F = (name: string, dtype: string, value: unknown) =>
  ({ name, dtype, definition: `${name} over the observed period`, value }) as FindingEntry;

const FINDINGS: FindingEntry[] = [
  F("cat_shares", "share", { shares_pct: { Other: 23.5, Groceries: 6.3 }, residual_pct: 5 }),
  F("spend_decomp", "decomposition", { volume: 6.2, rate: 3.8, dominant: "volume", residual: 0 }),
  F("daily_trend", "trend", { direction: "flat", slope_per_period: -0.01, p_value: 0.9 }),
];

const GEO_SERIES: SeriesEntry = {
  id: "isolated_buildings",
  rows: [
    { lat: 47.61, lng: -122.33, name: "A", nn_dist_m: 553.8 },
    { lat: 47.62, lng: -122.35, name: "B", nn_dist_m: 411.2 },
  ],
  roles: {
    x: { column: "name", kind: "categorical" },
    measures: [{ column: "nn_dist_m", unit: "m" }],
  },
};

const AXIS_SERIES: SeriesEntry = {
  id: "daily_spend",
  rows: [
    { date: "2026-07-01", spend_usd: 100, txns: 4 },
    { date: "2026-07-02", spend_usd: 80, txns: 3 },
  ],
  roles: {
    x: { column: "date", kind: "temporal" },
    measures: [{ column: "spend_usd", unit: "usd" }],
    count: { column: "txns" },
  },
};

const CTX = { series: [GEO_SERIES, AXIS_SERIES], maxViews: 4 };

const view = (over: Record<string, unknown>) => ({
  nodes: [
    { id: "a", op: "ANSWER" as const, refs: ["daily_trend"] },
    { id: "v", op: "VIEW" as const, refs: [], ...over },
  ],
});

describe("VIEW validation — licensing is blocking", () => {
  it("accepts a licensed geo view and a claim-fed composition view", () => {
    expect(
      validatePlan(view({ component: "MapView", series: "isolated_buildings" }), FINDINGS, CTX).ok
    ).toBe(true);
    expect(
      validatePlan(view({ component: "PieChart", refs: ["cat_shares"] }), FINDINGS, CTX).ok
    ).toBe(true);
    expect(
      validatePlan(view({ component: "WaterfallChart", refs: ["spend_decomp"] }), FINDINGS, CTX).ok
    ).toBe(true);
  });

  it("rejects unknown components, structural components, and shape mismatches", () => {
    const unknown = validatePlan(
      view({ component: "SparkleChart", series: "daily_spend" }),
      FINDINGS,
      CTX
    );
    expect(unknown.ok).toBe(false);
    expect(unknown.errors.join()).toContain("unknown component");
    const structural = validatePlan(
      view({ component: "LayoutGrid", series: "daily_spend" }),
      FINDINGS,
      CTX
    );
    expect(structural.errors.join()).toContain("not a data view");
    // A map over a non-geo series is a parse error, not a blank map.
    const wrongKind = validatePlan(
      view({ component: "MapView", series: "daily_spend" }),
      FINDINGS,
      CTX
    );
    expect(wrongKind.errors.join()).toContain("geo series");
    // Scatter needs two measures.
    const arity = validatePlan(
      view({ component: "ScatterChart", series: "daily_spend" }),
      FINDINGS,
      CTX
    );
    expect(arity.errors.join()).toContain("2+ measures");
    // Claim-fed with the wrong dtype.
    const dtype = validatePlan(
      view({ component: "PieChart", refs: ["daily_trend"] }),
      FINDINGS,
      CTX
    );
    expect(dtype.errors.join()).toContain("share");
    // Licensed but not yet compilable names the nearest alternatives.
    const tail = validatePlan(
      view({ component: "RidgelineChart", series: "daily_spend" }),
      FINDINGS,
      CTX
    );
    expect(tail.errors.join()).toContain("not yet compilable");
    expect(tail.errors.join()).toContain("Histogram");
  });

  it("enforces one VIEW per series and the purpose budget", () => {
    const two = {
      nodes: [
        { id: "a", op: "ANSWER" as const, refs: ["daily_trend"] },
        { id: "v1", op: "VIEW" as const, refs: [], component: "LineChart", series: "daily_spend" },
        { id: "v2", op: "VIEW" as const, refs: [], component: "Histogram", series: "daily_spend" },
      ],
    };
    const v = validatePlan(two, FINDINGS, CTX);
    expect(v.errors.join()).toContain("one view per series");
    const budget = validatePlan(two, FINDINGS, { ...CTX, maxViews: 1 });
    expect(budget.errors.join()).toContain("budget");
  });

  it("without series context, VIEW checks are structural only (edit path)", () => {
    expect(validatePlan(view({ component: "MapView", series: "anything" }), FINDINGS).ok).toBe(
      true
    );
    expect(validatePlan(view({ component: "Nope", series: "x" }), FINDINGS).ok).toBe(false);
  });

  it("salvage drops only the offending VIEW", () => {
    const { plan, repairs } = salvagePlan(
      view({ component: "MapView", series: "daily_spend" }),
      FINDINGS,
      CTX
    );
    expect(repairs.join()).toContain("geo series");
    expect(plan.nodes.map((n) => n.id)).toEqual(["a"]);
  });
});

describe("view compilers — props from declared roles, never authored", () => {
  const byName = new Map(FINDINGS.map((f) => [f.name, f]));

  it("MapView binds the series rows as markers", () => {
    const patch = compileViewNode(
      {
        id: "v",
        op: "VIEW",
        refs: [],
        component: "MapView",
        series: "isolated_buildings",
        text: "Most isolated buildings",
      },
      GEO_SERIES,
      byName
    )!;
    const el = patch.value as { type: string; props: Record<string, unknown> };
    expect(el.type).toBe("MapView");
    expect(el.props.markers).toBe("$chartData:isolated_buildings");
    expect(el.props.title).toBe("Most isolated buildings");
  });

  it("Histogram takes value_key from the first measure", () => {
    const patch = compileViewNode(
      { id: "v", op: "VIEW", refs: [], component: "Histogram", series: "daily_spend" },
      AXIS_SERIES,
      byName
    )!;
    const el = patch.value as { type: string; props: Record<string, unknown> };
    expect(el.props.value_key).toBe("spend_usd");
    expect(el.props.data).toBe("$chartData:daily_spend");
  });

  it("PieChart compiles ranked rows from the share claim", () => {
    const patch = compileViewNode(
      { id: "v", op: "VIEW", refs: ["cat_shares"], component: "PieChart" },
      undefined,
      byName
    )!;
    const el = patch.value as { type: string; props: { data: { label: string; value: number }[] } };
    expect(el.props.data[0]).toEqual({ label: "Other", value: 23.5 });
    expect(el.props.data[1]).toEqual({ label: "Groceries", value: 6.3 });
  });

  it("WaterfallChart compiles terms as relatives closed by a total", () => {
    const patch = compileViewNode(
      { id: "v", op: "VIEW", refs: ["spend_decomp"], component: "WaterfallChart" },
      undefined,
      byName
    )!;
    const el = patch.value as {
      props: { data: { label: string; value: number; type: string }[] };
    };
    const rows = el.props.data;
    expect(rows[rows.length - 1]).toEqual({ label: "Total", value: 10, type: "total" });
    expect(rows.filter((r) => r.type === "relative")).toHaveLength(2);
  });
});

describe("compiled assembly — the VIEW replaces the derived primary", () => {
  const MANIFEST: FindingsManifest = {
    manifest_version: "1",
    findings: FINDINGS,
  } as FindingsManifest;

  it("emits the VIEW element and suppresses the series' derived chart", () => {
    const lines = compileDashboard({
      manifest: MANIFEST,
      product: { series: [AXIS_SERIES], values: [] },
      plan: {
        nodes: [
          { id: "ans", op: "ANSWER", refs: ["daily_trend"], text: undefined },
          { id: "v1", op: "VIEW", refs: [], component: "Histogram", series: "daily_spend" },
        ],
      },
      overlay: {},
      headlinePlan: [],
      question: "q",
    });
    const all = lines.join("\n");
    expect(all).toContain('"Histogram"');
    expect(all).toContain("/elements/v1");
    // The derived primary (chart_daily_spend) is suppressed; the coverage
    // companion may still ship.
    expect(all).not.toContain('"/elements/chart_daily_spend"');
  });

  it("the planner prompt carries the generated view catalog", () => {
    const sys = buildPlannerSystem("dashboard");
    expect(sys).toContain("View catalog");
    expect(sys).toContain("MapView");
    expect(sys).toContain("WaterfallChart");
    expect(buildViewCatalog()).toContain("Histogram");
    // Prompt-size gate (spec review R4): the catalog block stays compact.
    expect(buildViewCatalog().length).toBeLessThan(4000);
  });
});
