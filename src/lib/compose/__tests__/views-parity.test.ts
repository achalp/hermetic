/**
 * VIEW plan op — P1 of compiled-view-parity (spec §2/§3): the planner
 * requests any licensed component; validation is blocking, salvage drops
 * only the offender, props are compiled from declared roles/claims, and a
 * compiled VIEW suppresses its series' derived primary (disclosure
 * variants survive).
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { FindingEntry, FindingsManifest } from "@/lib/contracts/findings";
import type { SeriesEntry } from "@/lib/contracts/product";
import { validatePlan, salvagePlan } from "@/lib/compose/plan";
import { compileViewNode, COMPILABLE_VIEWS } from "@/lib/compose/view-compilers";
import { compileDashboard } from "@/lib/compose/compile";
import { buildPlannerSystem, buildViewCatalog } from "@/lib/compose/planner";
import { catalogComponents, validateSpec } from "@/lib/catalog";
import { COMPONENT_ROLE_SIGNATURES } from "@/lib/product/signatures";

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
      view({ component: "Dendrogram", series: "daily_spend" }),
      FINDINGS,
      CTX
    );
    expect(tail.errors.join()).toContain("not yet compilable");
    expect(tail.errors.join()).toContain("SunburstChart");
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
    // Contract fields normalized, with the row's OTHER scalar attributes
    // riding along — the click popup renders them (the pin info box).
    expect(el.props.markers).toEqual([
      { lat: 47.61, lng: -122.33, label: "A", color: null, nn_dist_m: 553.8 },
      { lat: 47.62, lng: -122.35, label: "B", color: null, nn_dist_m: 411.2 },
    ]);
    // Region geometry rides along; the binding sweeps to null when absent.
    expect(el.props.geojson).toBe("$chartData:geojson");
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

  it("chart_data geometry always ships a map (run 8df300b3)", () => {
    const base = {
      manifest: MANIFEST,
      product: { series: [AXIS_SERIES], values: [] },
      overlay: {},
      headlinePlan: [],
      question: "show this data on a map",
    };
    const noMapPlan = {
      nodes: [{ id: "ans", op: "ANSWER" as const, refs: ["daily_trend"], text: undefined }],
    };
    // Geometry present, no map in the plan: the evidence map is injected.
    const lines = compileDashboard({ ...base, plan: noMapPlan, geojsonKey: "geojson" }).join("\n");
    expect(lines).toContain("compiled_geo_map");
    expect(lines).toContain('"$chartData:geojson"');
    // No geometry: no injection.
    expect(compileDashboard({ ...base, plan: noMapPlan }).join("\n")).not.toContain(
      "compiled_geo_map"
    );
    // A planner MapView VIEW already ships the geometry: no duplicate.
    const withView = {
      nodes: [
        { id: "ans", op: "ANSWER" as const, refs: ["daily_trend"], text: undefined },
        {
          id: "v1",
          op: "VIEW" as const,
          refs: [],
          component: "MapView",
          series: "isolated_buildings",
        },
      ],
    };
    const withMap = compileDashboard({
      ...base,
      product: { series: [GEO_SERIES], values: [] },
      plan: withView,
      geojsonKey: "geojson",
    }).join("\n");
    expect(withMap).not.toContain("compiled_geo_map");
  });

  it("the planner prompt carries the generated view catalog", () => {
    const sys = buildPlannerSystem("dashboard");
    expect(sys).toContain("View catalog");
    expect(sys).toContain("MapView");
    expect(sys).toContain("WaterfallChart");
    expect(buildViewCatalog()).toContain("Histogram");
    // Prompt-size gate (spec review R4): the catalog block stays compact.
    expect(buildViewCatalog().length).toBeLessThan(6500);
  });
});

// ── P3 conformance: every compilable component parses against its own ──
// catalog zod schema. The compiler output (bindings substituted with the
// declared rows, exactly as the finalizer resolves them) must satisfy the
// component's prop contract — compiler and component cannot drift, for
// all of them, mechanically.

const mkSeries = (
  id: string,
  rows: Record<string, unknown>[],
  roles: SeriesEntry["roles"],
  kind?: string
): SeriesEntry => ({ id, rows, roles, ...(kind ? { kind } : {}) }) as SeriesEntry;

const temporal2 = mkSeries(
  "t2",
  [
    { date: "2026-01-01", a: 10, b: 4 },
    { date: "2026-01-02", a: 12, b: 5 },
    { date: "2026-01-03", a: 9, b: 6 },
  ],
  { x: { column: "date", kind: "temporal" }, measures: [{ column: "a" }, { column: "b" }] }
);
const cat2 = mkSeries(
  "c2",
  [
    { seg: "A", a: 10, b: 4 },
    { seg: "B", a: 7, b: 9 },
  ],
  { x: { column: "seg", kind: "categorical" }, measures: [{ column: "a" }, { column: "b" }] }
);
const cat3 = mkSeries(
  "c3",
  [
    { seg: "A", a: 10, b: 4, c: 2 },
    { seg: "B", a: 7, b: 9, c: 3 },
  ],
  {
    x: { column: "seg", kind: "categorical" },
    measures: [{ column: "a" }, { column: "b" }, { column: "c" }],
  }
);
const grouped = mkSeries(
  "g1",
  [
    { date: "2026-01-01", g: "x", a: 1 },
    { date: "2026-01-01", g: "y", a: 2 },
    { date: "2026-01-02", g: "x", a: 3 },
    { date: "2026-01-02", g: "y", a: 4 },
  ],
  {
    x: { column: "date", kind: "temporal" },
    measures: [{ column: "a" }],
    group: { column: "g" },
  }
);
const distSeries = mkSeries(
  "d1",
  [
    { i: 1, v: 1.2, g: "k0" },
    { i: 2, v: 3.4, g: "k1" },
    { i: 3, v: 2.2, g: "k0" },
  ],
  {
    x: { column: "i", kind: "ordinal" },
    measures: [{ column: "v" }],
    group: { column: "g" },
  },
  "distribution"
);
const geoSeries = mkSeries(
  "geo1",
  [
    { lat: 47.6, lng: -122.3, name: "A", m: 5 },
    { lat: 47.7, lng: -122.2, name: "B", m: 9 },
  ],
  { x: { column: "name", kind: "categorical" }, measures: [{ column: "m" }] },
  "geo"
);
const matrixSeries = mkSeries(
  "m1",
  [
    { row: "r1", col: "c1", value: 1 },
    { row: "r1", col: "c2", value: 2 },
    { row: "r2", col: "c1", value: 3 },
    { row: "r2", col: "c2", value: 4 },
  ],
  { x: { column: "row", kind: "categorical" }, measures: [{ column: "value" }] },
  "matrix"
);
const numMatrix = mkSeries(
  "m2",
  [
    { row: "1", col: "1", value: 1 },
    { row: "1", col: "2", value: 2 },
    { row: "2", col: "1", value: 3 },
    { row: "2", col: "2", value: 4 },
  ],
  { x: { column: "row", kind: "ordinal" }, measures: [{ column: "value" }] },
  "matrix"
);
const lagSeries = mkSeries(
  "lags",
  [
    { lag: 0, v: 1.0 },
    { lag: 1, v: 0.5 },
  ],
  { x: { column: "lag", kind: "ordinal" }, measures: [{ column: "v" }] },
  "axis"
);
const flowSeries = mkSeries(
  "f1",
  [
    { source: "a", target: "b", weight: 3 },
    { source: "b", target: "c", weight: 2 },
  ],
  { x: { column: "source", kind: "categorical" }, measures: [{ column: "weight" }] },
  "flow"
);
const hierSeries = mkSeries(
  "h1",
  [
    { parent: "root1", child: "leaf1", value: 3 },
    { parent: "root1", child: "leaf2", value: 2 },
  ],
  { x: { column: "parent", kind: "categorical" }, measures: [{ column: "value" }] },
  "hierarchy"
);
const curveSeries = mkSeries(
  "cv1",
  [
    { x: 0, y: 1.0, lo: 0.9, hi: 1.0, g: "m" },
    { x: 1, y: 0.7, lo: 0.6, hi: 0.8, g: "m" },
  ],
  {
    x: { column: "x", kind: "ordinal" },
    measures: [{ column: "y" }],
    group: { column: "g" },
  },
  "curve"
);
const forestSeries = mkSeries(
  "fp1",
  [
    { x: "Overall", y: 1.2, lo: 1.0, hi: 1.4 },
    { x: "Region A", y: 0.9, lo: 0.7, hi: 1.1 },
  ],
  { x: { column: "x", kind: "categorical" }, measures: [{ column: "y" }] },
  "curve"
);
const ohlcSeries = mkSeries(
  "o1",
  [
    { t: "2026-01-01", open: 1, high: 2, low: 0.5, close: 1.5 },
    { t: "2026-01-02", open: 1.5, high: 2.5, low: 1.2, close: 2.0 },
  ],
  { x: { column: "t", kind: "temporal" }, measures: [{ column: "close" }] },
  "ohlc"
);
const spanSeries = mkSeries(
  "sp1",
  [
    { label: "phase 1", start: 0, end: 4 },
    { label: "phase 2", start: 4, end: 9 },
  ],
  { x: { column: "label", kind: "categorical" }, measures: [{ column: "end" }] },
  "span"
);
const vectorSeries = mkSeries(
  "vec1",
  [
    { x: 0, y: 0, angle: 30, magnitude: 2 },
    { x: 1, y: 1, angle: 120, magnitude: 1 },
  ],
  { x: { column: "x", kind: "ordinal" }, measures: [{ column: "magnitude" }] },
  "vector"
);
const calSeries = mkSeries(
  "cal1",
  [
    { day: "2026-01-01", v: 3 },
    { day: "2026-01-02", v: 5 },
  ],
  { x: { column: "day", kind: "temporal" }, measures: [{ column: "v" }] }
);

const shareClaim = {
  name: "shares1",
  dtype: "share",
  definition: "shares",
  value: { shares_pct: { A: 60, B: 40 }, residual_pct: 0 },
} as FindingEntry;
const decompClaim = {
  name: "decomp1",
  dtype: "decomposition",
  definition: "decomp",
  value: { volume: 6, rate: 4, dominant: "volume", residual: 0 },
} as FindingEntry;
const comparisonClaim = {
  name: "cmp1",
  dtype: "comparison",
  definition: "cmp",
  value: { early_median: 8.5, late_median: 34.7, early_n: 61, late_n: 69 },
} as FindingEntry;
const currentClaim = {
  name: "cur1",
  dtype: "current_state",
  definition: "cur",
  value: { period: "2026-07", value: 107.5, peak_value: 1027.4, peak_period: "2026-07-09" },
} as FindingEntry;

/** component → fixture: the series (series-fed) or claim (claim-fed). */
const FIXTURES_BY_COMPONENT: Record<string, { series?: SeriesEntry; claim?: FindingEntry }> = {
  BarChart: { series: cat2 },
  LineChart: { series: temporal2 },
  AreaChart: { series: temporal2 },
  ScatterChart: { series: cat2 },
  DualAxisChart: { series: temporal2 },
  ParetoChart: { series: cat2 },
  Sparkline: { series: temporal2 },
  ControlChart: { series: temporal2 },
  ErrorBarChart: { series: cat2 },
  PopulationPyramid: { series: cat2 },
  SlopeChart: { series: cat2 },
  DumbbellChart: { series: cat2 },
  BumpChart: { series: grouped },
  StreamChart: { series: grouped },
  RadarChart: { series: cat2 },
  ParallelCoordinates: { series: cat3 },
  CalendarChart: { series: calSeries },
  Scatter3D: { series: cat3 },
  TernaryChart: { series: cat3 },
  Histogram: { series: distSeries },
  BoxPlot: { series: distSeries },
  ViolinChart: { series: distSeries },
  BeeswarmChart: { series: distSeries },
  ECDFChart: { series: distSeries },
  QQPlot: { series: distSeries },
  RidgelineChart: { series: distSeries },
  SilhouettePlot: { series: distSeries },
  MapView: { series: geoSeries },
  Map3D: { series: geoSeries },
  Globe3D: { series: geoSeries },
  HeatMap: { series: matrixSeries },
  ConfusionMatrix: { series: matrixSeries },
  CohortGrid: { series: matrixSeries },
  Surface3D: { series: matrixSeries },
  ContourChart: { series: numMatrix },
  Correlogram: { series: lagSeries },
  SunburstChart: { series: hierSeries },
  SankeyChart: { series: flowSeries },
  ChordChart: { series: flowSeries },
  NetworkGraph: { series: flowSeries },
  RocCurve: { series: curveSeries },
  LiftChart: { series: curveSeries },
  CalibrationCurve: { series: curveSeries },
  SurvivalChart: { series: curveSeries },
  ForestPlot: { series: forestSeries },
  PartialDependence: { series: curveSeries },
  CandlestickChart: { series: ohlcSeries },
  GanttChart: { series: spanSeries },
  QuiverChart: { series: vectorSeries },
  WindRose: { series: vectorSeries },
  PieChart: { claim: shareClaim },
  TreemapChart: { claim: shareClaim },
  FunnelChart: { claim: shareClaim },
  WaterfallChart: { claim: decompClaim },
  TrendIndicator: { claim: comparisonClaim },
  GaugeChart: { claim: currentClaim },
  BulletChart: { claim: currentClaim },
  DefinitionList: { claim: currentClaim },
  DataTable: { series: cat2 },
};

/** Substitute $chartData bindings with the declared rows — what the
 *  finalizer does at resolution time. */
function resolveBindings(props: Record<string, unknown>, series?: SeriesEntry) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === "string" && v.startsWith("$chartData:")) {
      // geojson binds a FeatureCollection object; everything else binds rows.
      out[k] = k === "geojson" ? { type: "FeatureCollection", features: [] } : (series?.rows ?? []);
    } else out[k] = v;
  }
  return out;
}

describe("review 2026-08-15 fixes — wiring gaps closed", () => {
  it("claim-fed views pick the ref whose dtype the signature accepts", () => {
    const byName = new Map(
      [shareClaim, decompClaim, comparisonClaim, currentClaim].map((f) => [f.name, f])
    );
    const trendish = {
      name: "a_trend",
      dtype: "trend",
      definition: "t",
      value: { direction: "flat", slope_per_period: 1 },
    } as FindingEntry;
    byName.set(trendish.name, trendish);
    // refs list the trend FIRST — the validator passes because shares1
    // matches; the compiler must not grab the trend and compile nothing.
    const patch = compileViewNode(
      { id: "v", op: "VIEW", refs: ["a_trend", "shares1"], component: "PieChart" },
      undefined,
      byName
    );
    expect(patch, "PieChart silently dropped on mixed refs").toBeTruthy();
    const el = patch!.value as { props: { data: { label: string }[] } };
    expect(el.props.data[0].label).toBe("A");
  });

  it("group-required components reject at plan time, not silent compile drop", () => {
    const v = validatePlan(
      {
        nodes: [
          { id: "a", op: "ANSWER", refs: ["daily_trend"] },
          { id: "v1", op: "VIEW", refs: [], component: "BumpChart", series: "daily_spend" },
        ],
      },
      FINDINGS,
      CTX
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain("group role");
  });

  it("an EXPLAIN anchored to a suppressed primary re-points at the VIEW element", () => {
    const lines = compileDashboard({
      manifest: { manifest_version: "1", findings: FINDINGS } as FindingsManifest,
      product: { series: [AXIS_SERIES], values: [] },
      plan: {
        nodes: [
          { id: "ans", op: "ANSWER", refs: ["daily_trend"] },
          {
            id: "ex1",
            op: "EXPLAIN",
            refs: ["daily_trend"],
            text: "The histogram below shows the spread.",
            anchor: "chart_daily_spend",
          },
          { id: "v1", op: "VIEW", refs: [], component: "Histogram", series: "daily_spend" },
        ],
      },
      overlay: {},
      headlinePlan: [],
      question: "q",
    });
    const root = JSON.parse(lines[lines.length - 2]) as {
      value: { children: string[] };
    };
    const kids = root.value.children;
    expect(kids.indexOf("v1"), "VIEW not moved under its explainer").toBe(kids.indexOf("ex1") + 1);
    expect(lines.join("\n")).not.toContain('"/elements/chart_daily_spend"');
  });

  it("value-dependent gaps fail at plan time via the compiler dry-run", () => {
    // Curve series WITHOUT CI columns: ForestPlot licenses (kind curve) but
    // compiles to nothing — the validator now says so instead of a silent
    // render-time drop.
    const bareCurve = mkSeries(
      "cv_bare",
      [
        { x: "Overall", y: 1.2 },
        { x: "Region A", y: 0.9 },
      ],
      { x: { column: "x", kind: "categorical" }, measures: [{ column: "y" }] },
      "curve"
    );
    const v = validatePlan(
      {
        nodes: [
          { id: "a", op: "ANSWER", refs: ["daily_trend"] },
          { id: "v1", op: "VIEW", refs: [], component: "ForestPlot", series: "cv_bare" },
        ],
      },
      FINDINGS,
      { series: [bareCurve], maxViews: 4 }
    );
    expect(v.ok).toBe(false);
    expect(v.errors.join()).toContain("compiles to nothing");
    // Claim-fed: GaugeChart needs peak_value on the current_state claim.
    const peakless = {
      name: "cur_bare",
      dtype: "current_state",
      definition: "cur",
      value: { period: "2026-07", value: 10 },
    } as FindingEntry;
    const v2 = validatePlan(
      {
        nodes: [
          { id: "a", op: "ANSWER", refs: ["cur_bare"] },
          { id: "v1", op: "VIEW", refs: ["cur_bare"], component: "GaugeChart" },
        ],
      },
      [peakless],
      { series: [], maxViews: 4 }
    );
    expect(v2.ok).toBe(false);
    expect(v2.errors.join()).toContain("compiles to nothing from its claim");
  });

  it("a controlled series' VIEW chart joins the filter loop", () => {
    const lines = compileDashboard({
      manifest: { manifest_version: "1", findings: FINDINGS } as FindingsManifest,
      product: { series: [grouped], values: [] },
      plan: {
        nodes: [
          { id: "ans", op: "ANSWER", refs: ["daily_trend"] },
          { id: "v1", op: "VIEW", refs: [], component: "LineChart", series: "g1" },
        ],
      },
      overlay: {},
      headlinePlan: [],
      question: "q",
    });
    const all = lines.join("\n");
    expect(all).toContain("controls_g1");
    // The VIEW's data is rebound to the controller's computed output.
    const v1 = lines.find((l) => l.includes('"/elements/v1"'))!;
    expect(v1).toContain('"/computed/v1"');
    expect(v1).not.toContain("$chartData:g1");
    // Controls sit above the VIEW in the flow.
    const root = JSON.parse(lines[lines.length - 2]) as { value: { children: string[] } };
    const kids = root.value.children;
    expect(kids.indexOf("controls_g1")).toBeGreaterThan(-1);
    expect(kids.indexOf("controls_g1")).toBeLessThan(kids.indexOf("v1"));
  });

  it("investigate's step-prefixed geojson key threads through the channel", () => {
    const lines = compileDashboard({
      manifest: { manifest_version: "1", findings: FINDINGS } as FindingsManifest,
      product: { series: [AXIS_SERIES], values: [] },
      plan: { nodes: [{ id: "ans", op: "ANSWER", refs: ["daily_trend"] }] },
      overlay: {},
      headlinePlan: [],
      question: "q",
      geojsonKey: "step_2_geojson",
    });
    expect(lines.join("\n")).toContain('"$chartData:step_2_geojson"');
  });

  it("validateSpec tolerates the compiled composer's sparse props", () => {
    const byName = new Map([["cat_shares", FINDINGS[0]]]);
    const patch = compileViewNode(
      { id: "v", op: "VIEW", refs: ["cat_shares"], component: "PieChart" },
      undefined,
      byName
    )!;
    const spec = {
      root: "r",
      elements: {
        r: { type: "LayoutColumn", props: {}, children: ["v"] },
        v: patch.value,
      },
      state: {},
    };
    const check = validateSpec(spec);
    expect(check.success, check.error).toBe(true);
  });
});

describe("P3 conformance — every compilable view parses against its catalog schema", () => {
  it("every compilable component has a fixture (and vice versa)", () => {
    expect(Object.keys(FIXTURES_BY_COMPONENT).sort()).toEqual([...COMPILABLE_VIEWS].sort());
  });

  for (const component of [...COMPILABLE_VIEWS].sort()) {
    it(`${component} compiles and conforms`, () => {
      const fx = FIXTURES_BY_COMPONENT[component];
      const byName = new Map(
        [shareClaim, decompClaim, comparisonClaim, currentClaim].map((f) => [f.name, f])
      );
      const node = {
        id: `v_${component}`,
        op: "VIEW" as const,
        refs: fx.claim ? [fx.claim.name] : [],
        component,
        series: fx.series?.id,
        text: "Test view",
      };
      const patch = compileViewNode(node, fx.series, byName);
      expect(patch, `${component}: compiler returned null for a conforming fixture`).toBeTruthy();
      const value = patch!.value as { type: string; props: Record<string, unknown> };
      expect(value.type).toBe(component);
      const schema = (
        catalogComponents as unknown as Record<string, { props: z.ZodObject<z.ZodRawShape> }>
      )[component]?.props;
      expect(schema, `${component} missing from the catalog`).toBeTruthy();
      const resolved = resolveBindings(value.props, fx.series);
      const parsed = schema.partial().safeParse(resolved);
      expect(
        parsed.success,
        `${component} props violate the catalog schema: ${parsed.success ? "" : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
      ).toBe(true);
    });
  }

  it("licensing knows the not-yet-compilable tail explicitly", () => {
    const viewFeedable = Object.entries(COMPONENT_ROLE_SIGNATURES)
      .filter(([, sig]) => sig.feeds !== "none")
      .map(([name]) => name);
    const tail = viewFeedable.filter((c) => !COMPILABLE_VIEWS.has(c));
    // The named remainder — shapes no declarable series carries today.
    expect(tail.sort()).toEqual([
      "DecisionTree",
      "Dendrogram",
      "MarimekkoChart",
      "PivotTable",
      "ShapBeeswarm",
    ]);
  });
});
