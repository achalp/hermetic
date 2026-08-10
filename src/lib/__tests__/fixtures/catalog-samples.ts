// Representative, LLM-shaped props samples for catalog components (nulls
// included to mirror composer output). Shared by the schema-validation suite
// (chart-catalog-schemas.test.ts) and the render smoke suite
// (components/__tests__/catalog-render-smoke.test.tsx) so every sample is
// exercised both against its zod schema and through a real mount.

// Batch 1 (capability + analytics)
export const BATCH1_SAMPLES: Record<string, Record<string, unknown>> = {
  ErrorBarChart: {
    title: "Mean ± SE by group",
    data: [
      { group: "A", mean: 10, se: 1.2 },
      { group: "B", mean: 14, se: 0.9 },
    ],
    x_key: "group",
    y_key: "mean",
    error_key: "se",
    error_minus_key: null,
    group_key: null,
    mode: "markers",
    y_log: null,
    x_label: null,
    y_label: "Mean",
    color_map: null,
  },
  DualAxisChart: {
    title: "Revenue vs. margin",
    data: [
      { month: "Jan", revenue: 100, margin: 0.2 },
      { month: "Feb", revenue: 120, margin: 0.25 },
    ],
    x_key: "month",
    left_series: [{ key: "revenue", label: "Revenue", type: "bar", color: null }],
    right_series: [{ key: "margin", label: "Margin %", type: "line", color: "emerald" }],
    left_label: "Revenue",
    right_label: "Margin %",
    left_log: null,
    right_log: null,
    x_label: null,
  },
  FunnelChart: {
    title: "Signup funnel",
    data: [
      { label: "Visited", value: 1000 },
      { label: "Signed up", value: 420 },
      { label: "Purchased", value: 110 },
    ],
    orientation: "horizontal",
    show_percent: "initial",
    colors: null,
  },
  GaugeChart: {
    title: "SLA attainment",
    value: 96.4,
    min: 0,
    max: 100,
    target: 99,
    ranges: [
      { to: 90, color: "rose" },
      { to: 99, color: "amber" },
      { to: 100, color: "emerald" },
    ],
    reference: 95,
    bar_color: null,
    suffix: "%",
    prefix: null,
    number_format: null,
  },
  Sparkline: {
    title: null,
    data: [{ v: 3 }, { v: 5 }, { v: 4 }, { v: 7 }],
    value_key: "v",
    label: "Sessions",
    show_value: true,
    area: true,
    show_last_point: true,
    color: null,
  },
};

// Batch 2 (statistics)
export const BATCH2_SAMPLES: Record<string, Record<string, unknown>> = {
  ParetoChart: {
    title: "Defects by cause",
    data: [
      { label: "Scratch", value: 80 },
      { label: "Dent", value: 40 },
      { label: "Misprint", value: 12 },
    ],
    threshold_percent: 80,
    bar_color: null,
    line_color: null,
  },
  QQPlot: {
    title: "Normality check",
    data: [{ v: -1.2 }, { v: 0.1 }, { v: 0.9 }, { v: 2.3 }],
    value_key: "v",
    theoretical_key: null,
    sample_key: null,
    x_label: null,
    y_label: null,
    color: null,
  },
  ECDFChart: {
    title: "Latency ECDF",
    data: [{ ms: 12 }, { ms: 18 }, { ms: 25 }, { ms: 40 }],
    value_key: "ms",
    group_key: null,
    x_label: "Latency (ms)",
    complementary: null,
    color_map: null,
  },
  SurvivalChart: {
    title: "Retention",
    curves: [
      {
        label: "Cohort A",
        points: [
          { time: 0, survival: 1, lower: 1, upper: 1 },
          { time: 30, survival: 0.82, lower: 0.78, upper: 0.86 },
          { time: 60, survival: 0.65, lower: 0.6, upper: 0.7 },
        ],
      },
    ],
    x_label: "Days",
    y_label: null,
    show_ci: true,
    color_map: null,
  },
  ForestPlot: {
    title: "Subgroup effects",
    data: [
      { label: "Overall", estimate: 1.2, lower: 1.05, upper: 1.38 },
      { label: "Region A", estimate: 0.9, lower: 0.7, upper: 1.16 },
    ],
    reference_value: 1,
    x_label: "Hazard ratio",
    x_log: true,
    color: null,
  },
  ControlChart: {
    title: "Process mean",
    data: [{ v: 9.8 }, { v: 10.1 }, { v: 9.9 }, { v: 12.5 }, { v: 10.0 }],
    value_key: "v",
    x_key: null,
    center: null,
    ucl: null,
    lcl: null,
    sigma_multiple: 3,
    x_label: null,
    y_label: null,
    color: null,
  },
  Correlogram: {
    title: "ACF",
    data: [
      { lag: 0, value: 1 },
      { lag: 1, value: 0.6 },
      { lag: 2, value: 0.3 },
    ],
    n: 120,
    conf_band: null,
    kind: "acf",
    color: null,
  },
};

// Batch 3 (data science / ML)
export const BATCH3_SAMPLES: Record<string, Record<string, unknown>> = {
  CalibrationCurve: {
    title: "Reliability",
    curves: [
      {
        label: "Model A",
        predicted: [0.1, 0.4, 0.7, 0.9],
        observed: [0.08, 0.42, 0.66, 0.94],
      },
    ],
    show_diagonal: true,
    color_map: null,
  },
  LiftChart: {
    title: "Gain",
    curves: [{ label: "Model A", x: [0, 0.25, 0.5, 1], y: [0, 0.6, 0.85, 1] }],
    kind: "gain",
    show_baseline: true,
    color_map: null,
  },
  PartialDependence: {
    title: "PDP — age",
    x_values: [20, 30, 40, 50, 60],
    pdp: [0.1, 0.18, 0.3, 0.41, 0.5],
    ice: [
      [0.1, 0.15, 0.28, 0.4, 0.48],
      [0.12, 0.2, 0.32, 0.43, 0.52],
    ],
    feature_name: "Age",
    y_label: null,
    color: null,
  },
  Dendrogram: {
    title: "Cluster tree",
    icoord: [
      [5, 5, 15, 15],
      [25, 25, 35, 35],
    ],
    dcoord: [
      [0, 1.2, 1.2, 0],
      [0, 0.8, 0.8, 0],
    ],
    labels: ["a", "b", "c", "d"],
    orientation: "top",
    color: null,
  },
  SilhouettePlot: {
    title: "Silhouette",
    data: [
      { cluster: "0", s: 0.7 },
      { cluster: "0", s: 0.55 },
      { cluster: "1", s: 0.42 },
    ],
    cluster_key: "cluster",
    value_key: "s",
    avg_silhouette: null,
    color_map: null,
  },
  NetworkGraph: {
    title: "Co-occurrence",
    nodes: [
      { id: "A", x: 0, y: 0, label: "A", size: 12, group: "g1" },
      { id: "B", x: 1, y: 1, label: "B", size: 8, group: "g2" },
    ],
    edges: [{ source: "A", target: "B", weight: 3 }],
    show_labels: true,
    color_map: null,
  },
};

// Batch 4 (commerce / scientific)
export const BATCH4_SAMPLES: Record<string, Record<string, unknown>> = {
  ContourChart: {
    title: "Density",
    z: [
      [0, 1, 2],
      [1, 3, 2],
      [0, 2, 1],
    ],
    x: [0, 1, 2],
    y: [0, 1, 2],
    x_label: "x",
    y_label: "y",
    filled: true,
    ncontours: 10,
    colorscale: "Viridis",
  },
  TernaryChart: {
    title: "Soil composition",
    data: [
      { sand: 0.3, silt: 0.4, clay: 0.3, type: "A" },
      { sand: 0.6, silt: 0.2, clay: 0.2, type: "B" },
    ],
    a_key: "sand",
    b_key: "silt",
    c_key: "clay",
    a_label: "Sand",
    b_label: "Silt",
    c_label: "Clay",
    group_key: "type",
    size_key: null,
    color_map: null,
  },
  PopulationPyramid: {
    title: "Age × sex",
    data: [
      { band: "0-9", male: 120, female: 110 },
      { band: "10-19", male: 100, female: 98 },
    ],
    category_key: "band",
    left_key: "male",
    right_key: "female",
    left_label: "Male",
    right_label: "Female",
    left_color: null,
    right_color: null,
    x_label: "Population",
  },
  GanttChart: {
    title: "Project plan",
    tasks: [
      { task: "Design", start: "2026-01-01", end: "2026-01-15", group: "Phase 1" },
      { task: "Build", start: "2026-01-16", end: "2026-02-10", group: "Phase 2" },
    ],
    color_map: null,
  },
  CohortGrid: {
    title: "Retention",
    z: [
      [100, 60, 42],
      [100, 55, 38],
    ],
    row_labels: ["Jan", "Feb"],
    col_labels: ["M0", "M1", "M2"],
    value_suffix: "%",
    precision: 0,
    colorscale: "Blues",
    x_label: null,
    y_label: null,
  },
  QuiverChart: {
    title: "Flow field",
    data: [
      { x: 0, y: 0, u: 1, v: 0.5 },
      { x: 1, y: 1, u: -0.5, v: 1 },
    ],
    x_key: "x",
    y_key: "y",
    u_key: "u",
    v_key: "v",
    scale: 1,
    x_label: null,
    y_label: null,
    color: null,
  },
  WindRose: {
    title: "Wind",
    data: [
      { dir: "N", speed: "0-5", freq: 12 },
      { dir: "N", speed: "5-10", freq: 6 },
      { dir: "NE", speed: "0-5", freq: 9 },
    ],
    direction_key: "dir",
    bucket_key: "speed",
    value_key: "freq",
    color_map: null,
  },
};

// Core components (pre-batch catalog) — samples added by the modularization
// M0 render-smoke work. Extend toward full catalog coverage over time.
export const CORE_SAMPLES: Record<string, Record<string, unknown>> = {
  BarChart: {
    title: "Revenue by region",
    data: [
      { region: "West", revenue: 120 },
      { region: "East", revenue: 90 },
    ],
    x_key: "region",
    y_keys: ["revenue"],
    orientation: null,
    stacked: null,
    color_map: null,
    label_map: null,
    selects: null,
  },
  LineChart: {
    title: "Sessions over time",
    data: [
      { day: "Mon", sessions: 40 },
      { day: "Tue", sessions: 55 },
    ],
    x_key: "day",
    y_keys: ["sessions"],
    color_map: null,
    label_map: null,
    show_dots: null,
    curve: null,
  },
  AreaChart: {
    title: "Cumulative signups",
    data: [
      { week: "W1", signups: 10 },
      { week: "W2", signups: 25 },
    ],
    x_key: "week",
    y_keys: ["signups"],
    color_map: null,
    stacked: null,
    opacity: null,
  },
  PieChart: {
    title: "Share by segment",
    data: [
      { label: "SMB", value: 60 },
      { label: "Enterprise", value: 40 },
    ],
    show_labels: null,
    show_legend: null,
    donut: null,
    colors: null,
    selects: null,
  },
  ScatterChart: {
    title: "Price vs. rating",
    data: [
      { price: 10, rating: 4.1 },
      { price: 30, rating: 4.6 },
    ],
    x_key: "price",
    y_key: "rating",
    x_label: null,
    y_label: null,
    show_regression: null,
    group_key: null,
  },
  StatCard: {
    label: "Total revenue",
    value: "$1.2M",
    change: null,
    trend: null,
    description: null,
    format: null,
    precision: null,
  },
  TextBlock: { content: "Summary of findings", variant: "body" },
};

export const ALL_CATALOG_SAMPLES: Record<string, Record<string, unknown>> = {
  ...BATCH1_SAMPLES,
  ...BATCH2_SAMPLES,
  ...BATCH3_SAMPLES,
  ...BATCH4_SAMPLES,
  ...CORE_SAMPLES,
};
