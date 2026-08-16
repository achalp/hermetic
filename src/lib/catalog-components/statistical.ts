/**
 * Component catalog entries — one slice of the former catalog.ts god
 * module (L7). Merged by spread in ../catalog.ts; order is irrelevant.
 */
import { z } from "zod";

export const catalogStatistical = {
  BeeswarmChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      value_key: z.string(),
      group_key: z.string().nullable(),
      color_map: z.record(z.string(), z.string()).nullable(),
      marker_size: z.number().nullable(),
    }),
    description:
      "Beeswarm showing individual data points with jitter. Use for distribution of individual observations.",
  },
  ShapBeeswarm: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(
        z.object({
          feature: z.string(),
          shap_value: z.number(),
          feature_value: z.number(),
        })
      ),
      color_scale: z.string().nullable(),
      marker_size: z.number().nullable(),
    }),
    description:
      "SHAP beeswarm for ML feature importance. x=SHAP value, y=feature, color=feature value. Features sorted by importance.",
  },
  ConfusionMatrix: {
    props: z.object({
      title: z.string().nullable(),
      matrix: z.array(z.array(z.number())),
      labels: z.array(z.string()),
      color_scale: z.string().nullable(),
      normalize: z.boolean().nullable(),
    }),
    description:
      "Confusion matrix for ML classification. matrix[i][j] = count of actual=labels[i] predicted as labels[j]. normalize=true for percentages.",
  },
  RocCurve: {
    props: z.object({
      title: z.string().nullable(),
      curves: z.array(
        z.object({
          label: z.string(),
          fpr: z.array(z.number()),
          tpr: z.array(z.number()),
          auc: z.number().nullable(),
        })
      ),
      curve_type: z.enum(["roc", "pr"]).nullable(),
      color_map: z.record(z.string(), z.string()).nullable(),
      show_diagonal: z.boolean().nullable(),
    }),
    description:
      "ROC or Precision-Recall curve for ML evaluation. Multiple curves for model comparison. AUC shown in legend if provided.",
  },
  ParallelCoordinates: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      dimensions: z.array(z.string()),
      group_key: z.string().nullable(),
      color_map: z.record(z.string(), z.string()).nullable(),
      line_opacity: z.number().nullable(),
    }),
    description:
      "Parallel coordinates for multivariate data. Each axis is a dimension, each polyline is a row. Use for high-dimensional exploration.",
  },
  BulletChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(
        z.object({
          label: z.string(),
          value: z.number(),
          target: z.number().nullable(),
          ranges: z.array(z.number()),
        })
      ),
      orientation: z.enum(["vertical", "horizontal"]).nullable(),
      range_colors: z.array(z.string()).nullable(),
      value_color: z.string().nullable(),
    }),
    description:
      "Bullet chart for progress against targets with qualitative ranges. Use for KPI dashboards, goal tracking.",
  },
  DecisionTree: {
    props: z.object({
      title: z.string().nullable(),
      tree: z.record(z.string(), z.unknown()),
      orientation: z.enum(["vertical", "horizontal"]).nullable(),
      node_width: z.number().nullable(),
      node_height: z.number().nullable(),
    }),
    description:
      "Decision tree for ML interpretation or decision flowcharts. Branch nodes show conditions, leaves show values.",
  },
  ErrorBarChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      x_key: z.string(),
      y_key: z.string(),
      error_key: z.string().nullable(),
      error_minus_key: z.string().nullable(),
      group_key: z.string().nullable(),
      mode: z.enum(["markers", "bars"]).nullable(),
      y_log: z.boolean().nullable(),
      x_label: z.string().nullable(),
      y_label: z.string().nullable(),
      color_map: z.record(z.string(), z.string()).nullable(),
    }),
    description:
      "Points or bars with error bars / confidence intervals. error_key is the symmetric magnitude (SE, SD, or half-CI-width); set error_minus_key as well for asymmetric (then error_key is the upper). Use when comparing group means with uncertainty, measurement spread, or any value ± interval. Set y_log for log-scale y. group_key splits into coloured series.",
  },
  DualAxisChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      x_key: z.string(),
      // A series entry is a column name — either a bare string (which the LLM
      // commonly emits) or a spec object carrying its own styling. Both render;
      // see DualAxisChartComponent.toSeries.
      left_series: z.array(
        z.union([
          z.string(),
          z.object({
            key: z.string(),
            label: z.string().nullable(),
            type: z.enum(["bar", "line"]).nullable(),
            color: z.string().nullable(),
          }),
        ])
      ),
      right_series: z.array(
        z.union([
          z.string(),
          z.object({
            key: z.string(),
            label: z.string().nullable(),
            type: z.enum(["bar", "line"]).nullable(),
            color: z.string().nullable(),
          }),
        ])
      ),
      left_label: z.string().nullable(),
      right_label: z.string().nullable(),
      left_log: z.boolean().nullable(),
      right_log: z.boolean().nullable(),
      x_label: z.string().nullable(),
    }),
    description:
      "Combo chart with two independent y-axes for series on different scales/units (e.g. revenue vs. margin %, volume vs. price). Each series renders as a bar or line. Set left_log/right_log for log-scale axes. Use ONLY when units genuinely differ — otherwise prefer a normal bar/line chart.",
  },
  FunnelChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.object({ label: z.string(), value: z.number() })),
      orientation: z.enum(["vertical", "horizontal"]).nullable(),
      show_percent: z.enum(["initial", "previous", "none"]).nullable(),
      colors: z.array(z.string()).nullable(),
    }),
    description:
      "Funnel chart for sequential conversion / drop-off across ordered stages (e.g. signup → activation → purchase). Pass stages in order, highest at the top. show_percent: 'initial' (% of first stage) or 'previous' (step conversion).",
  },
  GaugeChart: {
    props: z.object({
      title: z.string().nullable(),
      value: z.number(),
      min: z.number().nullable(),
      max: z.number().nullable(),
      target: z.number().nullable(),
      ranges: z.array(z.object({ to: z.number(), color: z.string() })).nullable(),
      reference: z.number().nullable(),
      bar_color: z.string().nullable(),
      suffix: z.string().nullable(),
      prefix: z.string().nullable(),
      number_format: z.string().nullable(),
    }),
    description:
      "Radial gauge for a single KPI against a scale, with optional qualitative bands (ranges, ascending 'to' values) and a target threshold line. reference shows a delta. Use for one headline metric vs. goal; for several use StatCards or BulletChart.",
  },
  Sparkline: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      value_key: z.string(),
      label: z.string().nullable(),
      show_value: z.boolean().nullable(),
      area: z.boolean().nullable(),
      show_last_point: z.boolean().nullable(),
      color: z.string().nullable(),
    }),
    description:
      "Compact inline trend line with no axes — for a tiny sparkline beside a label/value (e.g. a metric's recent history in a row or stat strip). Use show_value to print the latest number. For a full trend with axes use LineChart.",
  },
  ParetoChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.object({ label: z.string(), value: z.number() })),
      threshold_percent: z.number().nullable(),
      bar_color: z.string().nullable(),
      line_color: z.string().nullable(),
    }),
    description:
      "Pareto chart: bars sorted descending with a cumulative-% line on a secondary axis and an 80% reference line. Use for the 80/20 rule — finding the vital few categories that drive most of a total (defects, revenue, complaints). Pass raw {label, value}; sorting and cumulative % are computed.",
  },
  QQPlot: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      value_key: z.string().nullable(),
      theoretical_key: z.string().nullable(),
      sample_key: z.string().nullable(),
      x_label: z.string().nullable(),
      y_label: z.string().nullable(),
      color: z.string().nullable(),
    }),
    description:
      "Quantile-quantile plot for checking whether a sample is normally distributed (points on the diagonal = normal). Pass raw values via value_key and theoretical normal quantiles are computed, OR pass precomputed theoretical_key + sample_key pairs.",
  },
  ECDFChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      value_key: z.string(),
      group_key: z.string().nullable(),
      x_label: z.string().nullable(),
      complementary: z.boolean().nullable(),
      color_map: z.record(z.string(), z.string()).nullable(),
    }),
    description:
      "Empirical cumulative distribution function (ECDF) as a step curve — shows the full distribution and percentiles without binning choices. Pass raw values via value_key; group_key draws one curve per group for comparison. Set complementary for a survival (1−F) view.",
  },
  SurvivalChart: {
    props: z.object({
      title: z.string().nullable(),
      curves: z.array(
        z.object({
          label: z.string(),
          points: z.array(
            z.object({
              time: z.number(),
              survival: z.number(),
              lower: z.number().nullable(),
              upper: z.number().nullable(),
            })
          ),
        })
      ),
      x_label: z.string().nullable(),
      y_label: z.string().nullable(),
      show_ci: z.boolean().nullable(),
      color_map: z.record(z.string(), z.string()).nullable(),
    }),
    description:
      "Kaplan–Meier survival curve(s) as descending step functions with optional confidence bands. Use for time-to-event / retention / churn analysis. Compute the KM estimate (e.g. lifelines KaplanMeierFitter) and pass precomputed {time, survival, lower?, upper?} points per group.",
  },
  ForestPlot: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(
        z.object({
          label: z.string(),
          estimate: z.number(),
          lower: z.number(),
          upper: z.number(),
        })
      ),
      reference_value: z.number().nullable(),
      x_label: z.string().nullable(),
      x_log: z.boolean().nullable(),
      color: z.string().nullable(),
    }),
    description:
      "Forest plot: point estimates with confidence intervals stacked vertically, plus a reference line (0 for differences, 1 for ratios). Use for meta-analyses, regression coefficients, or subgroup effect sizes. Set x_log for odds/hazard/risk ratios.",
  },
  ControlChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      value_key: z.string(),
      x_key: z.string().nullable(),
      center: z.number().nullable(),
      ucl: z.number().nullable(),
      lcl: z.number().nullable(),
      sigma_multiple: z.number().nullable(),
      x_label: z.string().nullable(),
      y_label: z.string().nullable(),
      color: z.string().nullable(),
    }),
    description:
      "Statistical process control (SPC) chart: a metric over time with a center line and upper/lower control limits; out-of-control points (beyond the limits) are highlighted red. Limits default to mean ± 3σ if not supplied. Use for process monitoring, quality control, anomaly spotting in sequential data.",
  },
  Correlogram: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.object({ lag: z.number(), value: z.number() })),
      n: z.number().nullable(),
      conf_band: z.number().nullable(),
      kind: z.enum(["acf", "pacf"]).nullable(),
      color: z.string().nullable(),
    }),
    description:
      "Correlogram (ACF or PACF): autocorrelation coefficient as stems per lag with a significance band. Use for time-series diagnostics — detecting seasonality, choosing ARIMA orders. Compute coefficients (e.g. statsmodels acf/pacf) and pass {lag, value}; provide n (sample size) for the ±1.96/√n band.",
  },
  CalibrationCurve: {
    props: z.object({
      title: z.string().nullable(),
      curves: z.array(
        z.object({
          label: z.string(),
          predicted: z.array(z.number()),
          observed: z.array(z.number()),
        })
      ),
      show_diagonal: z.boolean().nullable(),
      color_map: z.record(z.string(), z.string()).nullable(),
    }),
    description:
      "Calibration / reliability curve for a probabilistic classifier: mean predicted probability vs. observed fraction of positives, against the perfect-calibration diagonal. Multiple curves compare models. Compute with sklearn.calibration.calibration_curve and pass predicted/observed arrays per curve.",
  },
  LiftChart: {
    props: z.object({
      title: z.string().nullable(),
      curves: z.array(
        z.object({
          label: z.string(),
          x: z.array(z.number()),
          y: z.array(z.number()),
        })
      ),
      kind: z.enum(["lift", "gain"]).nullable(),
      show_baseline: z.boolean().nullable(),
      color_map: z.record(z.string(), z.string()).nullable(),
    }),
    description:
      "Lift or cumulative-gain chart for ranking/targeting model evaluation. x is the fraction of population targeted (0..1); y is lift (×) or cumulative gain (0..1). Use for marketing/propensity models. Baseline is 1× (lift) or the diagonal (gain).",
  },
  PartialDependence: {
    props: z.object({
      title: z.string().nullable(),
      x_values: z.array(z.number()),
      pdp: z.array(z.number()),
      ice: z.array(z.array(z.number())).nullable(),
      feature_name: z.string().nullable(),
      y_label: z.string().nullable(),
      color: z.string().nullable(),
    }),
    description:
      "Partial dependence plot (PDP) with optional ICE curves: how a model's prediction changes across one feature's range. pdp is the average effect; ice is one faint curve per instance (aligned to x_values). Compute with sklearn.inspection.partial_dependence. Use for model interpretation.",
  },
  Dendrogram: {
    props: z.object({
      title: z.string().nullable(),
      icoord: z.array(z.array(z.number())),
      dcoord: z.array(z.array(z.number())),
      labels: z.array(z.string()).nullable(),
      orientation: z.enum(["top", "left"]).nullable(),
      color: z.string().nullable(),
    }),
    description:
      "Dendrogram for hierarchical clustering. Pass the scipy dendrogram output directly: icoord, dcoord (link coordinates) and labels (leaf order, 'ivl'). Compute with scipy.cluster.hierarchy.linkage + dendrogram(no_plot=True). y-axis is merge distance.",
  },
  SilhouettePlot: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      cluster_key: z.string(),
      value_key: z.string(),
      avg_silhouette: z.number().nullable(),
      color_map: z.record(z.string(), z.string()).nullable(),
    }),
    description:
      "Silhouette plot for assessing clustering quality: per-sample silhouette coefficients grouped into cluster wedges, with the overall average marked. Pass one row per sample with its cluster label and silhouette value (sklearn.metrics.silhouette_samples). Wide/positive wedges indicate well-separated clusters.",
  },
  NetworkGraph: {
    props: z.object({
      title: z.string().nullable(),
      nodes: z.array(
        z.object({
          id: z.string(),
          x: z.number().nullable(),
          y: z.number().nullable(),
          label: z.string().nullable(),
          size: z.number().nullable(),
          group: z.string().nullable(),
        })
      ),
      edges: z.array(
        z.object({
          source: z.string(),
          target: z.string(),
          weight: z.number().nullable(),
        })
      ),
      show_labels: z.boolean().nullable(),
      color_map: z.record(z.string(), z.string()).nullable(),
    }),
    description:
      "Node-link network / graph for relationships (social graphs, dependencies, co-occurrence). Provide precomputed node x/y positions (e.g. networkx spring_layout) for a meaningful layout — otherwise nodes fall back to a circle. group colours nodes; size scales them. For flows between stages use SankeyChart instead.",
  },
  ContourChart: {
    props: z.object({
      title: z.string().nullable(),
      z: z.array(z.array(z.number())),
      x: z.array(z.number()).nullable(),
      y: z.array(z.number()).nullable(),
      x_label: z.string().nullable(),
      y_label: z.string().nullable(),
      filled: z.boolean().nullable(),
      ncontours: z.number().nullable(),
      colorscale: z.string().nullable(),
    }),
    description:
      "Contour plot of a 2D scalar field or density (z grid). Use for 2D kernel-density estimates, response surfaces, or topographic/level data. Pass z as a 2D array (rows=y, cols=x) with optional x/y coordinate axes; compute KDE on a grid (e.g. scipy.stats.gaussian_kde) for density. Set filled for filled bands vs. lines.",
  },
  TernaryChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      a_key: z.string(),
      b_key: z.string(),
      c_key: z.string(),
      a_label: z.string().nullable(),
      b_label: z.string().nullable(),
      c_label: z.string().nullable(),
      group_key: z.string().nullable(),
      size_key: z.string().nullable(),
      color_map: z.record(z.string(), z.string()).nullable(),
    }),
    description:
      "Ternary plot for three-part compositional data that sums to a whole (e.g. soil sand/silt/clay, vote share across 3 parties, portfolio mix). Each point has three components a/b/c. group_key colours by category; size_key scales markers.",
  },
  PopulationPyramid: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      category_key: z.string(),
      left_key: z.string(),
      right_key: z.string(),
      left_label: z.string().nullable(),
      right_label: z.string().nullable(),
      left_color: z.string().nullable(),
      right_color: z.string().nullable(),
      x_label: z.string().nullable(),
    }),
    description:
      "Population / pyramid chart: back-to-back horizontal bars comparing two groups across ordered categories (classically age bands by sex, but any A-vs-B breakdown by category). left_key is drawn to the left, right_key to the right.",
  },
  GanttChart: {
    props: z.object({
      title: z.string().nullable(),
      tasks: z.array(
        z.object({
          task: z.string(),
          start: z.union([z.string(), z.number()]),
          end: z.union([z.string(), z.number()]),
          group: z.string().nullable(),
        })
      ),
      color_map: z.record(z.string(), z.string()).nullable(),
    }),
    description:
      "Gantt / timeline chart: horizontal bars spanning each task's start→end on a date axis. Use for project schedules, phase timelines, or any interval-per-entity data. start/end are ISO date strings or epoch ms; group colours and legends the bars.",
  },
  CohortGrid: {
    props: z.object({
      title: z.string().nullable(),
      z: z.array(z.array(z.number())),
      row_labels: z.array(z.string()),
      col_labels: z.array(z.string()),
      value_suffix: z.string().nullable(),
      precision: z.number().nullable(),
      colorscale: z.string().nullable(),
      x_label: z.string().nullable(),
      y_label: z.string().nullable(),
    }),
    description:
      "Cohort retention grid: a labelled, colour-coded matrix of cohorts (rows) by period-since-start (columns), each cell a retention/value figure. Use for retention, churn, and cohort analysis. Pass z as the matrix with row_labels (cohorts) and col_labels (periods); value_suffix like '%'.",
  },
  QuiverChart: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      x_key: z.string(),
      y_key: z.string(),
      u_key: z.string(),
      v_key: z.string(),
      scale: z.number().nullable(),
      x_label: z.string().nullable(),
      y_label: z.string().nullable(),
      color: z.string().nullable(),
    }),
    description:
      "Quiver / vector-field plot: arrows showing direction and magnitude at grid points. Use for flow fields, gradients, or 2D force/velocity data. Each row is {x, y, u, v} (position + vector components); scale multiplies arrow length.",
  },
  WindRose: {
    props: z.object({
      title: z.string().nullable(),
      data: z.array(z.record(z.string(), z.unknown())),
      direction_key: z.string(),
      bucket_key: z.string().nullable(),
      value_key: z.string().nullable(),
      color_map: z.record(z.string(), z.string()).nullable(),
    }),
    description:
      "Wind rose / polar histogram: stacked petals showing frequency by compass direction, split into magnitude buckets. Use for directional data (wind speed/direction, but any angle × magnitude distribution works). direction_key names the direction column (degrees 0–360 or compass labels N/NE/…). Accepts EITHER wide rows {direction, <band1>: freq, <band2>: freq, ...} (one row per direction, one numeric column per band — the natural pivot output; leave bucket_key/value_key null) OR long rows {direction, bucket, frequency} (set bucket_key and value_key). CRITICAL: bind data to the EXACT same state/result key the analysis writes the aggregated table to — the key name in the chart's data binding must match the analysis output key character-for-character.",
  },
};
