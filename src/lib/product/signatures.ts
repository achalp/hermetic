/**
 * Component role signatures — the LICENSING registry of the compiled-view-
 * parity spec (specs/compiled-view-parity-2026-08-13.md §3).
 *
 * Every catalog component carries a signature: its FAMILY (which props
 * compiler builds it — compose/view-compilers.ts), what it FEEDS on
 * (a declared series, a claim, or nothing — `none` components are not
 * view-requestable), the shapes it accepts, and a one-line `when` clause
 * the planner catalog is GENERATED from (one source of truth, zero drift).
 *
 * Two enforcement postures over one registry:
 *  - compiled mode: a VIEW plan node is validated BLOCKING against its
 *    signature (validatePlan) — a shape mismatch is a parse error the
 *    planner retries on, and salvage drops the node (the derived floor
 *    ships);
 *  - generative mode: lintComponentSignature keeps its advisory posture.
 *
 * The closure tests (signatures.test) assert every catalog component has a
 * signature and every signature names a catalog component — component #85
 * cannot ship unlicensed.
 */
import type { SeriesXKind } from "@/lib/contracts/product";
import type { FindingIssue } from "@/lib/contracts/findings";
import type { ProductRolesIndex } from "./index";

export type SignatureFamily =
  | "axis" // x + y_keys over declared rows
  | "distribution" // raw values of one measure (value_key over rows)
  | "composition" // parts of a whole (label/value rows or tree)
  | "geo" // lat/lng markers
  | "matrix" // row x col x value
  | "hierarchy" // parent/child or nested tree
  | "flow" // source/target/weight
  | "curve" // named curves of points (CI-carrying)
  | "ohlc" // open/high/low/close over time
  | "span" // label + start/end
  | "vector" // directional/angular data
  | "stat" // single-value indicators
  | "table" // row display
  | "layout" // structural containers
  | "input" // interactive controls
  | "media"; // static content

export interface ComponentSignature {
  family: SignatureFamily;
  /** What a VIEW binds: a declared series, a claim (via refs), or nothing —
   *  `none` components are structural/interactive and never VIEW targets. */
  feeds: "series" | "claim" | "none";
  /** One-line planner guidance; the prompt catalog is generated from it. */
  when?: string;
  /** Axis-family licensing: accepted x kinds (absent = any). */
  xKinds?: SeriesXKind[];
  /** Series kinds (declared or inferred — seriesKindOf) that satisfy the
   *  component. Absent = the default "axis" kind. */
  seriesKinds?: string[];
  /** Measure arity bounds for series-fed components. */
  minMeasures?: number;
  maxMeasures?: number;
  /** Claim-fed licensing: accepted claim dtypes. */
  dtypes?: string[];
}

export const COMPONENT_ROLE_SIGNATURES: Record<string, ComponentSignature> = {
  // ── Layout / structural (never VIEW targets) ─────────────────────
  LayoutRow: { family: "layout", feeds: "none" },
  LayoutColumn: { family: "layout", feeds: "none" },
  LayoutGrid: { family: "layout", feeds: "none" },
  SectionBreak: { family: "layout", feeds: "none" },
  TextBlock: { family: "layout", feeds: "none" },
  Annotation: { family: "layout", feeds: "none" },
  ChartImage: { family: "media", feeds: "none" },
  // ── Inputs / controllers (derived interactivity owns these) ──────
  SelectControl: { family: "input", feeds: "none" },
  NumberInput: { family: "input", feeds: "none" },
  ToggleSwitch: { family: "input", feeds: "none" },
  DataController: { family: "input", feeds: "none" },
  FormController: { family: "input", feeds: "none" },
  TextInput: { family: "input", feeds: "none" },
  TextArea: { family: "input", feeds: "none" },
  DatePicker: { family: "input", feeds: "none" },
  Slider: { family: "input", feeds: "none" },
  ColorPicker: { family: "input", feeds: "none" },
  MultiSelect: { family: "input", feeds: "none" },
  RangeSlider: { family: "input", feeds: "none" },
  // ── Stat indicators ──────────────────────────────────────────────
  StatCard: { family: "stat", feeds: "none" }, // headline tiles own these
  TrendIndicator: {
    family: "stat",
    feeds: "claim",
    dtypes: ["comparison"],
    when: "a compact current-vs-previous chip for one comparison claim",
  },
  GaugeChart: {
    family: "stat",
    feeds: "claim",
    dtypes: ["current_state"],
    when: "a bounded level against its range/peak (needs known bounds)",
  },
  BulletChart: {
    family: "stat",
    feeds: "claim",
    dtypes: ["current_state"],
    when: "actual vs peak level in minimal space",
  },
  Sparkline: {
    family: "axis",
    feeds: "series",
    xKinds: ["temporal", "ordinal"],
    when: "a tiny inline trend beside prose (no axes)",
  },
  // ── Tables ───────────────────────────────────────────────────────
  DataTable: { family: "table", feeds: "series", when: "exact rows the reader will scan or sort" },
  PivotTable: {
    family: "table",
    feeds: "series",
    when: "rows the reader will re-group interactively",
  },
  DefinitionList: {
    family: "table",
    feeds: "claim",
    when: "labeled key figures of one claim as a definition list",
  },
  // ── Axis family (x + measures over declared rows) ────────────────
  BarChart: { family: "axis", feeds: "series", when: "magnitudes compared across categories" },
  LineChart: {
    family: "axis",
    feeds: "series",
    xKinds: ["temporal", "ordinal"],
    when: "a measure moving over time/order",
  },
  AreaChart: {
    family: "axis",
    feeds: "series",
    xKinds: ["temporal", "ordinal"],
    when: "cumulative or filled magnitude over time",
  },
  ScatterChart: {
    family: "axis",
    feeds: "series",
    minMeasures: 2,
    when: "the relationship between two measures (pair with a correlation claim)",
  },
  DualAxisChart: {
    family: "axis",
    feeds: "series",
    xKinds: ["temporal", "ordinal"],
    minMeasures: 2,
    when: "two measures on different scales over one axis",
  },
  ParetoChart: {
    family: "axis",
    feeds: "series",
    xKinds: ["categorical"],
    when: "ranked categories with a cumulative-share line (the vital few)",
  },
  CalendarChart: {
    family: "axis",
    feeds: "series",
    xKinds: ["temporal"],
    when: "daily values on a calendar grid (weekday/seasonal texture)",
  },
  ControlChart: {
    family: "axis",
    feeds: "series",
    xKinds: ["temporal", "ordinal"],
    when: "a process measure against control limits",
  },
  ErrorBarChart: {
    family: "axis",
    feeds: "series",
    minMeasures: 2,
    when: "point estimates with their uncertainty per group",
  },
  SlopeChart: {
    family: "axis",
    feeds: "series",
    minMeasures: 2,
    when: "before-vs-after levels per category (two periods only)",
  },
  DumbbellChart: {
    family: "axis",
    feeds: "series",
    minMeasures: 2,
    when: "the gap between two values per category",
  },
  BumpChart: {
    family: "axis",
    feeds: "series",
    xKinds: ["temporal", "ordinal"],
    when: "rank changes of groups over time (needs a group role)",
  },
  StreamChart: {
    family: "axis",
    feeds: "series",
    xKinds: ["temporal", "ordinal"],
    when: "stacked group magnitudes flowing over time (needs a group role)",
  },
  RadarChart: {
    family: "axis",
    feeds: "series",
    xKinds: ["categorical"],
    when: "one or few entities profiled across shared dimensions",
  },
  ParallelCoordinates: {
    family: "axis",
    feeds: "series",
    minMeasures: 3,
    when: "many entities across 3+ measures (cluster/outlier texture)",
  },
  PopulationPyramid: {
    family: "axis",
    feeds: "series",
    xKinds: ["categorical", "ordinal"],
    minMeasures: 2,
    when: "two opposed cohorts across ordered bins",
  },
  Scatter3D: {
    family: "axis",
    feeds: "series",
    minMeasures: 3,
    when: "three measures per entity in 3D",
  },
  CandlestickChart: {
    family: "ohlc",
    feeds: "series",
    seriesKinds: ["ohlc"],
    xKinds: ["temporal"],
    when: "open/high/low/close per period",
  },
  GanttChart: {
    family: "span",
    feeds: "series",
    seriesKinds: ["span"],
    when: "labeled start/end spans on a timeline",
  },
  // ── Distribution family (raw values of one measure) ──────────────
  Histogram: {
    family: "distribution",
    feeds: "series",
    when: "the shape of one measure's values (pair with a distribution claim)",
  },
  BoxPlot: {
    family: "distribution",
    feeds: "series",
    when: "median/IQR/outliers of a measure, optionally per group",
  },
  ViolinChart: {
    family: "distribution",
    feeds: "series",
    when: "full density of a measure per group",
  },
  RidgelineChart: {
    family: "distribution",
    feeds: "series",
    when: "one distribution per group, stacked (needs a group role)",
  },
  BeeswarmChart: {
    family: "distribution",
    feeds: "series",
    when: "every individual value visible, clustered by magnitude",
  },
  ECDFChart: {
    family: "distribution",
    feeds: "series",
    when: "what share of values falls below each level",
  },
  QQPlot: {
    family: "distribution",
    feeds: "series",
    when: "normality/shape check of one measure",
  },
  ShapBeeswarm: {
    family: "distribution",
    feeds: "series",
    seriesKinds: ["matrix"],
    when: "per-feature attribution values (model explanation data)",
  },
  // ── Composition family (parts of a whole; claim-fed) ─────────────
  PieChart: {
    family: "composition",
    feeds: "claim",
    dtypes: ["share"],
    // xKinds kept for the GENERATIVE advisory (a pie over a temporal x
    // slices a time axis); the claim-fed VIEW path never binds a series.
    xKinds: ["categorical"],
    when: "a share claim's parts of a whole (few slices)",
  },
  TreemapChart: {
    family: "composition",
    feeds: "claim",
    dtypes: ["share"],
    when: "a share claim with many parts — area encodes share",
  },
  FunnelChart: {
    family: "composition",
    feeds: "claim",
    dtypes: ["share"],
    when: "ordered stage drop-off (a share claim whose parts are stages)",
  },
  WaterfallChart: {
    family: "composition",
    feeds: "claim",
    dtypes: ["decomposition"],
    when: "a decomposition claim: how parts bridge a total change",
  },
  SunburstChart: {
    family: "hierarchy",
    feeds: "series",
    seriesKinds: ["hierarchy"],
    when: "nested shares over 2+ levels",
  },
  MarimekkoChart: {
    family: "composition",
    feeds: "series",
    seriesKinds: ["matrix"],
    when: "two-dimensional shares (segment x category)",
  },
  // ── Geo family ───────────────────────────────────────────────────
  MapView: {
    family: "geo",
    feeds: "series",
    seriesKinds: ["geo"],
    when: "entities with lat/lng — THE answer view for spatial questions",
  },
  Map3D: {
    family: "geo",
    feeds: "series",
    seriesKinds: ["geo"],
    when: "lat/lng entities with a magnitude worth extruding",
  },
  Globe3D: {
    family: "geo",
    feeds: "series",
    seriesKinds: ["geo"],
    when: "planet-scale point spread",
  },
  // ── Matrix family ────────────────────────────────────────────────
  HeatMap: {
    family: "matrix",
    feeds: "series",
    seriesKinds: ["matrix"],
    when: "a value over two categorical dimensions (row+col+value rows)",
  },
  ConfusionMatrix: {
    family: "matrix",
    feeds: "series",
    seriesKinds: ["matrix"],
    when: "predicted vs actual class counts",
  },
  Correlogram: {
    family: "matrix",
    feeds: "series",
    seriesKinds: ["axis"],
    when: "autocorrelation by lag (lag x + one measure)",
  },
  CohortGrid: {
    family: "matrix",
    feeds: "series",
    seriesKinds: ["matrix"],
    when: "cohort x period retention values",
  },
  SilhouettePlot: {
    family: "distribution",
    feeds: "series",
    seriesKinds: ["distribution"],
    when: "cluster quality per sample (needs a group role)",
  },
  ContourChart: {
    family: "matrix",
    feeds: "series",
    seriesKinds: ["matrix"],
    when: "a surface's level sets over two continuous axes",
  },
  Surface3D: {
    family: "matrix",
    feeds: "series",
    seriesKinds: ["matrix"],
    when: "a value surface over two axes in 3D",
  },
  // ── Hierarchy / flow ─────────────────────────────────────────────
  DecisionTree: {
    family: "hierarchy",
    feeds: "series",
    seriesKinds: ["hierarchy"],
    when: "split rules as a tree",
  },
  Dendrogram: {
    family: "hierarchy",
    feeds: "series",
    seriesKinds: ["hierarchy"],
    when: "hierarchical cluster merges",
  },
  SankeyChart: {
    family: "flow",
    feeds: "series",
    seriesKinds: ["flow"],
    when: "quantities flowing between stages/categories",
  },
  ChordChart: {
    family: "flow",
    feeds: "series",
    seriesKinds: ["flow"],
    when: "pairwise flows among a closed set of groups",
  },
  NetworkGraph: {
    family: "flow",
    feeds: "series",
    seriesKinds: ["flow"],
    when: "entities and weighted relations as a graph",
  },
  // ── Curve family (named curves, CI-carrying) ─────────────────────
  RocCurve: {
    family: "curve",
    feeds: "series",
    seriesKinds: ["curve"],
    when: "classifier TPR/FPR trade-off",
  },
  LiftChart: {
    family: "curve",
    feeds: "series",
    seriesKinds: ["curve"],
    when: "model lift/gain over baseline",
  },
  CalibrationCurve: {
    family: "curve",
    feeds: "series",
    seriesKinds: ["curve"],
    when: "predicted vs observed probability",
  },
  SurvivalChart: {
    family: "curve",
    feeds: "series",
    seriesKinds: ["curve"],
    when: "survival/retention over time with CI bands",
  },
  ForestPlot: {
    family: "curve",
    feeds: "series",
    seriesKinds: ["curve"],
    when: "per-group effect estimates with intervals",
  },
  PartialDependence: {
    family: "curve",
    feeds: "series",
    seriesKinds: ["curve"],
    when: "a model's response to one feature",
  },
  // ── Vector / niche ───────────────────────────────────────────────
  QuiverChart: {
    family: "vector",
    feeds: "series",
    seriesKinds: ["vector"],
    when: "directional vectors on a plane",
  },
  WindRose: {
    family: "vector",
    feeds: "series",
    seriesKinds: ["vector"],
    when: "magnitudes by angular direction",
  },
  TernaryChart: {
    family: "axis",
    feeds: "series",
    minMeasures: 3,
    when: "three-part compositions on a triangle (three share measures)",
  },
};

/** The series KIND for licensing (compiled-view-parity §4). Declared kind
 *  wins; P1 infers exactly ONE kind — geo — because lat/lng morphology is
 *  unambiguous (the same aliases MapView's normalizeMarkers accepts).
 *  Everything else defaults to "axis"; richer kinds arrive with P2's
 *  declare_series(kind=...) and are never inferred. */
export function seriesKindOf(s: { kind?: string; rows?: unknown[] }): string {
  if (typeof s.kind === "string" && s.kind !== "") return s.kind;
  const first = Array.isArray(s.rows) ? s.rows[0] : undefined;
  if (first && typeof first === "object") {
    const keys = Object.keys(first as Record<string, unknown>).map((k) => k.toLowerCase());
    const hasLat = keys.includes("lat") || keys.includes("latitude");
    const hasLng = keys.includes("lng") || keys.includes("lon") || keys.includes("longitude");
    if (hasLat && hasLng) return "geo";
  }
  return "axis";
}

const BINDING_RE = /\$(?:chartData|series):([a-zA-Z0-9_]+)/;

/**
 * Check one PRE-resolution spec line (GENERATIVE path — advisory): a
 * component whose props bind a DECLARED series must accept that series' x
 * kind. Post-resolution the binding token is gone, so callers pass the raw
 * line. Undeclared chart keys are unchecked (no roles to check against).
 */
export function lintComponentSignature(
  rawLine: string,
  rolesIdx: ProductRolesIndex
): FindingIssue[] {
  if (rolesIdx.size === 0 || !rawLine.includes("$")) return [];
  let patch: { value?: { type?: unknown; props?: unknown } };
  try {
    patch = JSON.parse(rawLine) as typeof patch;
  } catch {
    return [];
  }
  const type = patch.value?.type;
  if (typeof type !== "string") return [];
  const sig = COMPONENT_ROLE_SIGNATURES[type];
  if (!sig?.xKinds) return [];
  const m = BINDING_RE.exec(JSON.stringify(patch.value?.props ?? {}));
  if (!m) return [];
  const info = rolesIdx.get(m[1]);
  if (!info || sig.xKinds.includes(info.xKind as SeriesXKind)) return [];
  return [
    {
      kind: "component_role_mismatch",
      name: m[1],
      detail: `${type} binds series ${m[1]}, whose declared x (${info.xCol}) is ${info.xKind} — ${type} renders ${sig.xKinds.join("/")} x axes; use a component matching the declared kind (e.g. BarChart for categories, LineChart for time)`,
    },
  ];
}
