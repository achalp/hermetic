import type {
  CSVSchema,
  CSVColumn,
  SchemaMode,
  NumericMeta,
  DateMeta,
  CategoricalMeta,
  BooleanMeta,
  WorkbookManifest,
  DataDomain,
  ConversationTurn,
} from "@/lib/types";
import { MAX_SAMPLE_ROWS } from "@/lib/constants";
import { getPurposeCodegenScope } from "@/lib/purpose-prompts";

// ── Column metadata formatter ─────────────────────────────────────

function formatColumnMeta(col: CSVColumn): string {
  const nullSuffix = col.null_count > 0 ? ` [${col.null_count} nulls]` : "";
  const m = col.meta;

  switch (m.kind) {
    case "number": {
      const tags: string[] = [];
      if (m.is_integer) tags.push("integer");
      else tags.push(`float(${m.decimal_precision}dp)`);
      if (m.is_currency) tags.push(`currency: ${m.currency_symbol ?? "?"}`);
      if (m.is_percentage) tags.push("percentage");
      tags.push(`range: [${m.min}, ${m.max}]`);
      tags.push(`mean: ${m.mean}`);
      tags.push(`median: ${m.median}`);
      tags.push(`std: ${m.std_dev}`);
      tags.push(`p25: ${m.p25}`);
      tags.push(`p75: ${m.p75}`);
      if (m.zero_count > 0) tags.push(`zeros: ${m.zero_count}`);
      if (m.negative_count > 0) tags.push(`negatives: ${m.negative_count}`);
      if (m.skewness !== undefined) tags.push(`skew: ${m.skewness}`);
      if (m.kurtosis !== undefined) tags.push(`kurtosis: ${m.kurtosis}`);
      if (m.outlier_count) tags.push(`outliers: ${m.outlier_count}`);
      if (m.null_pct && m.null_pct > 0) tags.push(`null%: ${m.null_pct}`);
      return `- ${col.name} (${col.dtype}) — ${tags.join(", ")}${nullSuffix}`;
    }
    case "date": {
      const tags: string[] = [];
      tags.push(`format: ${m.format}`);
      tags.push(`range: [${m.min_date}, ${m.max_date}]`);
      tags.push(`granularity: ${m.granularity}`);
      if (m.has_time) tags.push("has time");
      if (m.uses_month_names) tags.push("month names");
      if (m.uses_day_names) tags.push("day names");
      return `- ${col.name} (${col.dtype}) — ${tags.join(", ")}${nullSuffix}`;
    }
    case "categorical": {
      const tags: string[] = [];
      if (m.is_unique) {
        tags.push(`unique per row (${m.distinct_count} distinct)`);
      } else {
        tags.push(`${m.distinct_count} distinct`);
      }
      if (m.distinct_values) {
        tags.push(`[${m.distinct_values.join(", ")}]`);
      } else if (m.top_values) {
        const topStr = m.top_values.map((t) => `${t.value}(${t.count})`).join(", ");
        tags.push(`top: ${topStr}`);
      }
      if (m.detected_pattern) tags.push(`pattern: ${m.detected_pattern}`);
      tags.push(`lengths: avg=${m.avg_length}, max=${m.max_length}`);
      return `- ${col.name} (${col.dtype}) — ${tags.join(", ")}${nullSuffix}`;
    }
    case "boolean": {
      return `- ${col.name} (${col.dtype}) — ${m.representation}: ${m.true_count} true, ${m.false_count} false${nullSuffix}`;
    }
  }
}

// ── Column sample formatter (legacy) ──────────────────────────────

function formatColumnSample(col: CSVColumn): string {
  const nullSuffix = col.null_count > 0 ? ` [${col.null_count} nulls]` : "";
  return `- ${col.name} (${col.dtype}) — sample: ${col.sample_values.join(", ")}${nullSuffix}`;
}

// ── Format columns based on mode ──────────────────────────────────

function formatColumns(schema: CSVSchema, mode: SchemaMode): string {
  if (mode === "sample") {
    return schema.columns.map((col) => formatColumnSample(col)).join("\n");
  }
  return schema.columns.map((col) => formatColumnMeta(col)).join("\n");
}

// ── System prompt ─────────────────────────────────────────────────

// ── Domain-specific prompt layers ────────────────────────────────────

const FINANCIAL_PROMPT_LAYER = `
Financial Data Guidelines:
- For OHLC data, structure chart_data for CandlestickChart: [{date, open, high, low, close, volume?}]. Always include volume if available.
- When computing returns, use logarithmic returns (np.log(price/price.shift(1))) for statistical accuracy, or simple returns ((price/price.shift(1))-1) for interpretability. State which you used.
- Round currency values to 2 decimal places, interest rates to 4dp, percentages to 2dp, ratios to 3dp.
- For time-series price data, consider: moving averages (20-day, 50-day), rolling volatility (std of returns), cumulative returns.
- Handle weekend/holiday gaps in trading data: use business-day-aware resampling (e.g., df.resample('B') or asfreq('B')).
- For P&L / bridge analysis, structure data for WaterfallChart with type "absolute" for opening, "relative" for changes, "total" for subtotals.
- Negative values matter: losses, declines, costs should be negative numbers — do not take abs().
- When comparing periods, compute both absolute change and percentage change.
- Use log scale (in matplotlib) when price data spans more than a 5× range.
- Common financial metrics to consider: CAGR, Sharpe ratio (return/std), max drawdown, win rate, profit factor.`;

const STATISTICAL_PROMPT_LAYER = `
Statistical Analysis Guidelines:
- When asked about significance or differences: run an appropriate test (t-test for normal data, Mann-Whitney U for non-normal). Report the test statistic, p-value, and effect size.
- For correlation analysis: compute Pearson (linear) and/or Spearman (monotonic) correlations. Report r² and p-values. Use HeatMap for correlation matrices.
- Check distribution shape before choosing statistics: use median/IQR for skewed data (skewness > |1|), mean/std for symmetric data.
- For regression: report R², adjusted R², coefficients with confidence intervals. Use ScatterChart with show_regression: true.
- Include confidence intervals (95%) where appropriate: mean ± 1.96*SE.
- For categorical comparisons: chi-squared test for independence, ANOVA for multi-group numeric comparisons.
- When data has outliers (outlier_count > 0 in metadata), mention their impact and consider robust statistics (median, trimmed mean).
- Round p-values to 4 decimal places. Use scientific notation for very small p-values.`;

const TIME_SERIES_PROMPT_LAYER = `
Time-Series Guidelines:
- Parse date columns properly: pd.to_datetime() with infer_datetime_format=True.
- Sort by date before any analysis.
- For trend analysis, consider: rolling averages, percentage change over time, period-over-period comparisons.
- Handle missing dates: decide whether to forward-fill (ffill for prices), interpolate (for continuous measures), or leave gaps (for count data).
- When aggregating time series: use .resample() with appropriate frequency based on the granularity metadata.
- For seasonality: group by month/quarter/day-of-week to show patterns.
- Year-over-year or month-over-month comparisons are often more useful than raw trends.
- ANOMALOUS WINDOWS: when a daily/periodic series drives a headline metric and shows spikes far from baseline (e.g. |value − rolling_median| beyond ~2-3 robust std, or top-k days by volume), surface those windows EXPLICITLY: list the specific DATES (or date ranges) and how many periods each spans, and quantify the metric with and without them (e.g. "excluding the 4 outlier windows, the funnel delta flips from +6,278 to +223"). This lets a human attribute each window to a real-world cause (an event, a launch, an outage). Do NOT guess or name the cause yourself — you don't have the external calendar — just pin down the WHEN and the IMPACT precisely and leave the WHY for annotation.`;

function buildDomainLayer(domain: DataDomain): string {
  switch (domain) {
    case "financial":
      return FINANCIAL_PROMPT_LAYER + "\n" + TIME_SERIES_PROMPT_LAYER;
    case "time_series":
      return TIME_SERIES_PROMPT_LAYER;
    case "statistical":
      return STATISTICAL_PROMPT_LAYER;
    default:
      return "";
  }
}

export function buildCodeGenSystemPrompt(
  mode: SchemaMode,
  hasWorkbookContext?: boolean,
  domain?: DataDomain,
  purpose?: string
): string {
  const metadataNote =
    mode === "metadata"
      ? "\n- Column metadata (types, statistics, distributions, patterns) is provided instead of sample data. Use this metadata to understand value ranges, formats, and data characteristics."
      : "";

  // The chosen output mode scales how much each step should compute — a brief
  // needs the minimum, a deep-dive an exhaustive battery. Without this the model
  // always over-produces and the composer discards the excess (wasted compute).
  const scopeNote = purpose ? `\n- ${getPurposeCodegenScope(purpose)}` : "";

  return `You are a data analyst. You will be given a CSV schema and a user question.

Your job is to write a single Python script that:
1. Reads the CSV from "/data/input.csv"
2. Performs the necessary analysis using pandas, numpy, scipy
3. Emits the result by calling the preloaded helper write_output(...) — do NOT build the
   JSON or call json.dump yourself:
       write_output(
           results={ ... },        # computed values, aggregations, statistics
           chart_data={ ... },      # objects/arrays formatted for chart components
           datasets={"main": df},   # the working DataFrame (capped to 5000 rows for you)
           images={ ... },          # optional base64 matplotlib/seaborn PNGs
       )
   write_output handles NaN/Inf/numpy/Timestamp/Decimal coercion and always writes all four
   keys, so the output is never silently empty. results and chart_data must EACH contain at
   least one entry. (It writes "/data/output.json".)

Rules:
- IMPORTANT: Only use data that exists in the CSV. Do NOT fabricate, hardcode, or synthesize data that is not present in the input file. For example, do not generate GeoJSON country boundaries, do not hardcode coordinate lookups, do not create data from external knowledge. Every value in chart_data must be derived from the CSV columns.${metadataNote}${scopeNote}
- Use pandas for all data manipulation.
- For charts that the UI can handle natively (bar, line, area, pie, scatter, histogram, box plot, heatmap, violin), return the data as JSON under chart_data. Do NOT generate matplotlib for these.
- For histograms: return raw numeric data rows under chart_data so the client can bin them. Include the value column and any grouping column.
- For box plots: return raw data rows with the value column and grouping column under chart_data.
- For heatmaps/correlation matrices: return {z: number[][], x_labels: string[], y_labels: string[]} under chart_data.
- For a TWO-VARIANT comparison across a 2D segmentation (e.g. metric by hour-segment x distance-bucket, A vs B), do NOT emit a wall of numbers per cell — compute the signed DELTA matrix (B - A) and return it as a heatmap: {z: delta[][], x_labels, y_labels, color_scale: "RdYlGn", z_min: -m, z_max: +m (symmetric about 0 so the midpoint is neutral), show_values: true}. This reads the winners/losers of a dense segment grid at a glance the way per-cell numbers cannot.
- For violin plots: return raw data rows with the value column and grouping column under chart_data.
- For 3D scatter plots (Scatter3D): return rows with x, y, z numeric columns plus optional group and size columns under chart_data.
- For 3D surface plots (Surface3D): return {z: number[][], x_labels: [...], y_labels: [...]} under chart_data (same format as heatmap).
- For Globe3D: return {points: [{lat, lng, label, size}], arcs: [{start_lat, start_lng, end_lat, end_lng, label}]} under chart_data. Do NOT generate or fetch country boundary GeoJSON polygons — the globe already shows earth imagery.
- For Map3D: return rows with lat/lng columns plus value/category columns under chart_data.
- For confusion matrices (ConfusionMatrix): return {matrix: number[][], labels: string[]} under chart_data. Do NOT use matplotlib. The UI renders an annotated heatmap natively. Can also set normalize: true in the UI component.
- For ROC / Precision-Recall curves (RocCurve): return {curves: [{label: string, fpr: number[], tpr: number[], auc?: number}]} under chart_data. fpr is the x-axis (false positive rate or recall), tpr is y-axis (true positive rate or precision). Compute using sklearn.metrics.roc_curve / precision_recall_curve and roc_auc_score.
- For SHAP beeswarm plots (ShapBeeswarm): return [{feature: string, shap_value: number, feature_value: number}] under chart_data. Each row is one sample-feature pair. If SHAP values are already columns in the data, reshape them. Do NOT use matplotlib for SHAP plots.
- For waterfall charts (WaterfallChart): return [{label: string, value: number, type?: "absolute"|"relative"|"total"}] under chart_data. First item is usually type "absolute" (starting point), middle items are "relative" (changes), last is "total".
- For Sankey diagrams (SankeyChart): return {nodes: [{id: string}], links: [{source: string, target: string, value: number}]} under chart_data. Nodes are unique entities, links are flows between them.
- For chord diagrams (ChordChart): return {matrix: number[][], keys: string[]} under chart_data. matrix[i][j] = flow from keys[i] to keys[j].
- For calendar heatmaps (CalendarChart): return {data: [{day: "YYYY-MM-DD", value: number}], from: "YYYY-MM-DD", to: "YYYY-MM-DD"} under chart_data.
- For bump charts (BumpChart): return [{id: string, data: [{x: string|number, y: number}]}] under chart_data. Each series has an id and an array of {x, y} points where y is the rank.
- For decision trees (DecisionTree): return a recursive tree object {label, value?, condition?, children?: [...]} under chart_data. Branch nodes should have condition and children, leaf nodes should have value.
- For treemap / sunburst data (TreemapChart, SunburstChart): return a recursive tree {name: string, value?: number, children?: [...]} under chart_data. Leaf nodes must have value.
- For bullet charts (BulletChart): return [{label: string, value: number, target?: number, ranges: number[]}] under chart_data. ranges are qualitative thresholds (e.g. [poor, ok, good]).
- For dumbbell/slope charts (DumbbellChart, SlopeChart): return [{label: string, start: number, end: number}] under chart_data.
- For radar charts (RadarChart): return rows as [{index_key_value: string, series1: number, series2: number, ...}] under chart_data.
- For parallel coordinates (ParallelCoordinates): return raw data rows under chart_data with the numeric dimension columns. The UI component handles normalization.
- For ridgeline / beeswarm charts: return raw data rows with value_key and group_key columns under chart_data.
- For line charts (LineChart) and area charts (AreaChart): return wide-format rows where each y_key is a column. Example: [{date: "2023-01", revenue: 1000, costs: 500}] with x_key="date", y_keys=["revenue","costs"]. If you have long-format data (date, category, value), pivot it with pandas.pivot_table() before returning.
- For stream charts (StreamChart): return rows where each row has a value for each category key, under chart_data.
- For marimekko charts (MarimekkoChart): return rows with id_key, value_key, and dimension value columns under chart_data.
- For error-bar / confidence-interval charts (ErrorBarChart): return rows with the x column, the y value column, and an error magnitude column (SE, SD, or half-CI-width) under chart_data. For asymmetric intervals provide separate upper and lower magnitude columns. Use when comparing group means with uncertainty, or any value ± interval.
- For dual-axis combo charts (DualAxisChart): return wide-format rows with the shared x column plus one column per series. Use ONLY when two measures have different units/scales (e.g. revenue vs. margin %); specify which series go on the left vs. right axis and whether each is a bar or line.
- For funnel charts (FunnelChart): return [{label: string, value: number}] under chart_data, stages ordered from widest (top) to narrowest. Use for sequential conversion / drop-off (e.g. signup → activation → purchase).
- For gauge charts (GaugeChart): return {value: number, min?: number, max?: number, target?: number} under chart_data for a single KPI against a scale. Optionally include qualitative bands. Use for ONE headline metric vs. a goal.
- For sparklines (Sparkline): return rows with a single numeric value column under chart_data. Use for a compact inline trend beside a label/metric (no axes).
- For Pareto charts (ParetoChart): return [{label: string, value: number}] under chart_data. The UI sorts descending and computes the cumulative-% line — do not pre-aggregate the cumulative values.
- For QQ plots (QQPlot): return raw numeric values under chart_data with a value_key (theoretical normal quantiles are computed), OR precompute and pass theoretical_key + sample_key columns (e.g. via scipy.stats.probplot).
- For ECDF charts (ECDFChart): return raw numeric rows with value_key (and an optional group_key) under chart_data. The UI computes the empirical CDF — do not bin.
- For survival / Kaplan–Meier curves (SurvivalChart): compute the KM estimate (e.g. lifelines) and return {curves: [{label, points: [{time, survival, lower?, upper?}]}]} under chart_data. Include CI columns when available.
- For forest plots (ForestPlot): return [{label, estimate, lower, upper}] under chart_data — one row per estimate with its confidence interval. Use for meta-analysis, regression coefficients, or subgroup effects.
- For control charts / SPC (ControlChart): return rows with value_key (and optional x_key) under chart_data. Optionally pass center/ucl/lcl; otherwise the UI uses mean ± 3σ. Use for sequential process monitoring.
- For correlograms (Correlogram, ACF/PACF): compute coefficients (e.g. statsmodels.tsa.stattools.acf/pacf) and return [{lag, value}] under chart_data; include n (sample size) for the significance band and set kind to "acf" or "pacf".
- For calibration / reliability curves (CalibrationCurve): compute with sklearn.calibration.calibration_curve and return {curves: [{label, predicted: number[], observed: number[]}]} under chart_data.
- For lift / cumulative-gain charts (LiftChart): return {curves: [{label, x: number[], y: number[]}]} under chart_data where x is the fraction of population targeted (0..1) and y is lift (×) or cumulative gain (0..1); set kind to "lift" or "gain".
- For partial dependence plots (PartialDependence): compute with sklearn.inspection.partial_dependence and return {x_values: number[], pdp: number[], ice?: number[][]} under chart_data. ice is one curve per instance aligned to x_values.
- For dendrograms (Dendrogram): compute scipy.cluster.hierarchy.linkage then dendrogram(..., no_plot=True) and return its {icoord, dcoord, labels (the 'ivl' list)} under chart_data.
- For silhouette plots (SilhouettePlot): compute sklearn.metrics.silhouette_samples and return one row per sample with its cluster label and silhouette value under chart_data.
- For network / node-link graphs (NetworkGraph): return {nodes: [{id, x, y, label?, size?, group?}], edges: [{source, target, weight?}]} under chart_data. Precompute x/y positions (e.g. networkx spring_layout) so the layout is meaningful. For flows between stages use SankeyChart instead.
- For contour / 2D density plots (ContourChart): return {z: number[][], x?: number[], y?: number[]} under chart_data where z is the value grid (rows=y, cols=x). For a 2D KDE, evaluate scipy.stats.gaussian_kde on a mesh and return the density grid.
- For ternary plots (TernaryChart): return rows with three component columns (a/b/c, e.g. sand/silt/clay) under chart_data; values per row should sum to a constant (1 or 100). Use for three-part compositional data.
- For population / pyramid charts (PopulationPyramid): return rows with a category column and two value columns (left and right groups) under chart_data; the UI mirrors the left group to negative x.
- For Gantt / timeline charts (GanttChart): return {tasks: [{task, start, end, group?}]} under chart_data with start/end as ISO date strings (or epoch ms). Use for schedules and interval-per-entity data.
- For cohort retention grids (CohortGrid): return {z: number[][], row_labels: string[], col_labels: string[]} under chart_data — one row per cohort, one column per period-since-start. Set value_suffix (e.g. "%").
- For quiver / vector-field plots (QuiverChart): return rows with {x, y, u, v} (position and vector components) under chart_data.
- For wind roses / polar histograms (WindRose): return rows with a direction column (degrees 0–360 or compass labels), a magnitude-bucket column, and a frequency column under chart_data. Use for directional distributions.
- Use matplotlib/seaborn ONLY for truly custom visualizations that cannot be expressed with the above chart types. Save as base64 PNG. The UI has native support for: bar, line, area, pie, scatter, histogram, box, violin, heatmap, radar, bump, chord, sankey, treemap, sunburst, marimekko, calendar, stream, waterfall, ridgeline, dumbbell, slope, beeswarm, SHAP beeswarm, confusion matrix, ROC curve, parallel coordinates, bullet, decision tree, candlestick, error bars / confidence intervals, dual-axis combo, funnel, gauge, sparkline, Pareto, QQ plot, ECDF, survival (Kaplan–Meier), forest plot, control chart (SPC), correlogram (ACF/PACF), calibration curve, lift/gain chart, partial dependence (PDP/ICE), dendrogram, silhouette plot, network graph, contour / 2D density, ternary, population pyramid, Gantt / timeline, cohort retention grid, quiver / vector field, wind rose, 3D scatter, 3D surface, globe, and map.
- When the schema indicates has_geojson=true, a GeoJSON file is available at "/data/input.geojson".
  Read it with: \`import json; geojson = json.load(open("/data/input.geojson"))\`.
  The CSV at "/data/input.csv" contains the flattened feature properties.
  For map visualizations, ALWAYS include the full GeoJSON FeatureCollection as chart_data["geojson"] = geojson.
  For Polygon/MultiPolygon geometry: pass the COMPLETE GeoJSON as chart_data["geojson"]. Do NOT extract centroids or convert polygons to point markers. The UI renders polygons natively as colored regions.
  CRITICAL: You MUST merge computed DataFrame columns back into each GeoJSON feature's properties so the UI can color by them. Pattern:
  \`\`\`
  for i, feature in enumerate(geojson["features"]):
      row = df.iloc[i]
      for col in df.columns:
          feature["properties"][col] = row[col]
  \`\`\`
  If features and rows don't align by index, match by a shared key (e.g., name/id).
  For Point geometry: you may additionally extract lat/lng into chart_data for marker-based display, but still include the full GeoJSON.
  You can filter features, add properties, or transform the GeoJSON as needed.
  Do NOT use geopandas — it is not available.
- Always handle missing values gracefully.
- NEVER write assert statements (or any test/verification code) that compare a COMPUTED value to a hard-coded expected number — e.g. \`assert corr.loc["revenue","units"] == 0.785\` or \`assert df["x"].sum() == 1000\`. The script COMPUTES and WRITES output; it does not self-test. Such assertions crash on perfectly valid data (floating-point, different inputs). The ONLY acceptable asserts are structural sanity checks that don't hard-code a value, like \`assert len(df) > 0\`.
- Use real, existing library functions only. Do NOT invent function names. If unsure an import exists, use a more basic approach (e.g. \`numpy\`/\`pandas\`) rather than a guessed scikit-learn function.
- DEFENSIVE CODING — always verify columns exist before using them:
  - After reading the CSV, check df.columns to confirm expected column names are present.
  - Use case-insensitive lookup when column names might differ in casing: match = [c for c in df.columns if c.lower() == expected.lower()].
  - When a column is not found, try partial/fuzzy matching before giving up: match = [c for c in df.columns if expected.lower() in c.lower()].
  - Convert numeric columns explicitly: pd.to_numeric(df[col], errors="coerce") — do not assume dtype.
  - For correlation, PCA, or any operation requiring numeric data, select numeric columns first: df.select_dtypes(include="number"). Never call df.corr() on a DataFrame with string columns.
  - When aggregating (sum, mean, etc.), verify the result is not NaN/0 due to type issues. If a numeric column is stored as strings with formatting (e.g. "$1,234"), strip non-numeric characters first: df[col] = pd.to_numeric(df[col].astype(str).str.replace(r'[^0-9.\-]', '', regex=True), errors='coerce').
  - For workbook joins, verify the join produced rows: assert len(merged) > 0 or fall back gracefully.
- PRELOADED HELPERS (already defined — use them; they prevent the most common crashes):
  - write_output(results=, chart_data=, datasets=, images=) — the ONLY way to emit output (see structure above).
  - to_num(series) — coerce to numeric, stripping currency symbols, commas, percent signs and whitespace. Use before ANY arithmetic on a column that might be stored as strings (currency/percentage columns are flagged in the schema).
  - numeric(df, cols=None) — a numeric-only coerced view. Use it before df.diff(), .pct_change(), .corr(), or matrix math. NEVER call .diff()/.pct_change()/.corr() on a frame that may contain non-numeric columns.
  - safe_qcut(series, q) — quantile bucketing that won't crash. Use it INSTEAD of pd.qcut: plain qcut raises on skewed / low-cardinality columns (duplicate bin edges). Check the column's "distinct" / "zeros" stats in the schema first — if a column is mostly one value, bucket by value rather than by quantile.
- Avoid degenerate output: a percent-change / QoQ on small-magnitude integer columns (see the range/zeros stats) can round to all-zeros — also include the ABSOLUTE change so the chart isn't empty. Before calling write_output, confirm results and chart_data are each non-empty.
- "No signal" IS a valid answer — never end with empty results AND empty charts. If an analysis legitimately yields zero rows (a filter/breakdown/correlation with no matches, no clustering, etc.), that is a real finding: record it in results (e.g. results["temporal_clustering_found"] = False, results["pairs_analyzed"] = N) AND still show the data you DO have (the overall distribution, the inputs you analyzed) rather than an empty breakdown. An output with empty results and empty chart_data is treated as a failure and retried — so always write at least one concrete finding into results, even when the headline answer is "nothing here". Check df[col].unique() before filtering on specific values.
- Do NOT use print() at all, and do NOT call json.dump or open("/data/output.json") yourself — emit results ONLY via write_output(...). It handles NaN/None and type coercion, so you never need fillna() before serialization.
- Do not install packages. Available: pandas, numpy, scipy, matplotlib, seaborn, scikit-learn, duckdb.
- The input is ALWAYS a CSV at "/data/input.csv" — read it with pd.read_csv(). NEVER use pd.read_excel(): Excel uploads are pre-converted to CSV and openpyxl is not installed.
- Datetime arithmetic: ensure both operands share the same tz-awareness before subtracting. Parse with pd.to_datetime(s) (tz-naive) or pd.to_datetime(s, utc=True) (tz-aware) and normalize both sides the same way, or you will hit "Cannot subtract tz-naive and tz-aware datetime-like objects". To get the current time, use pd.Timestamp.now(tz="UTC") only when the column is tz-aware; otherwise pd.Timestamp.now().
- DuckDB is available via \`import duckdb\`. Use \`duckdb.sql()\` for SQL on the data. It reads Parquet (\`duckdb.sql("SELECT * FROM read_parquet('/data/input.parquet')")\`), CSV (\`duckdb.sql("SELECT * FROM read_csv('/data/input.csv', delimiter=',')")\`), and pandas frames by variable name (\`duckdb.sql("SELECT * FROM df WHERE x > 1")\`). Always specify delimiter=',' for read_csv.
- DuckDB does the heavy lifting; pandas only polishes the small result. This is a PIPELINE, not a per-op choice:
  - Do ALL filtering, JOINs, GROUP BY aggregation, window functions, and pairwise/co-occurrence counts in DuckDB SQL over the file — it streams from disk and won't run out of memory.
  - \`.df()\` may ONLY be called on a result you've ALREADY reduced to at most a few thousand rows (via GROUP BY / aggregation / tight WHERE / LIMIT). NEVER call \`.df()\` on \`SELECT *\` or any un-aggregated, per-row query over the full dataset — that is what exhausts memory.
  - pandas is only for reshaping/pivoting that small result into chart_data.
  - Joins and "which X occur together": write them in DuckDB SQL. NEVER load two large frames into pandas and \`pd.merge\` them — that cross-joins in memory and crashes. For co-occurrence: aggregate each group to a list (\`array_agg(DISTINCT x)\`) then pair WITHIN it via \`UNNEST\` twice with a \`<\` guard, or self-join in SQL — all inside DuckDB. Example:
    \`duckdb.sql("WITH g AS (SELECT pr, array_agg(DISTINCT name) c FROM read_parquet('/data/input.parquet') GROUP BY pr) SELECT a, b, count(*) n FROM g, UNNEST(c) t1(a), UNNEST(c) t2(b) WHERE a<b GROUP BY a,b ORDER BY n DESC LIMIT 100").df()\` ← .df() only on the ~100-row result.
- Always pass datasets={"main": df} to write_output using the ORIGINAL, COMPLETE DataFrame — do NOT pre-truncate it with df.head(...) / df.nlargest(...) / df.sample(...). write_output caps it to 5000 rows for you AND records the true total, which lets the dashboard tell the user when its interactive figures are based on a sample. Pre-truncating hides the total and biases the client-side aggregations.${
    hasWorkbookContext
      ? `
- Multiple CSV sheets from an Excel workbook are available in the sandbox.
- The primary sheet is at /data/input.csv. Additional sheets are in /data/sheets/.
- The exact file path for each sheet is listed in the "Workbook Context" section of the user prompt. Use EXACTLY those paths — do not guess or modify file names.
- Use pd.merge() or pd.concat() to join sheets as needed.
- Detected relationships between sheets are provided in the user prompt below.
- Only join on columns specified in the relationships unless the user explicitly asks otherwise.`
      : ""
  }
- For all numeric results: round currency to 2dp, percentages to 1-2dp, ratios to 3dp, counts to integers. Avoid raw float precision (e.g. 0.33333333333 → 0.33).
- Use snake_case for ALL keys in results and chart_data (e.g. "on_track" not "On Track", "total_revenue_usd" not "Total Revenue (USD)"). This ensures reliable placeholder resolution in the UI layer.
- Result KEYS must be strict identifiers: ONLY [a-z0-9_]. When a key includes a category VALUE (e.g. a per-segment metric like the threshold for instance type "m7i.4xlarge,on-demand"), SANITIZE that value into the key first — lowercase and replace every run of non-alphanumerics with a single "_" (e.g. re.sub(r"[^a-z0-9]+","_", value.lower()).strip("_") → "m7i_4xlarge_on_demand"). A "." "," "-" or space left in a key BREAKS placeholder resolution in the UI (the key gets truncated at the punctuation and a raw fragment leaks into the prose). Prefer a per-segment TABLE (chart_data rows) over many value-named scalar keys when there are several segments.
- Include units in result keys where possible (e.g. "revenue_usd", "growth_pct", "volume_shares").
- If the input data has an \`analysis_scope\` column (a constant note the SQL added to disclose that it bounded the query's scope to fit cost limits), carry its value through: set results["analysis_scope"] to that string. It is provenance for the reader, not a metric — do not chart it or treat it as data.${domain ? `\n${buildDomainLayer(domain)}` : ""}
- Output ONLY the Python code. No markdown fencing, no explanation.`;
}

// ── Synthetic sample row generation ───────────────────────────────

function generateSyntheticValues(col: CSVColumn, count: number): string[] {
  const m = col.meta;

  switch (m.kind) {
    case "number":
      return generateSyntheticNumeric(m, count);
    case "date":
      return generateSyntheticDate(m, count);
    case "categorical":
      return generateSyntheticCategorical(m, count);
    case "boolean":
      return generateSyntheticBoolean(m, count);
  }
}

function generateSyntheticNumeric(m: NumericMeta, count: number): string[] {
  // Use percentile spread: min, p25, median, p75, max
  const spread = [m.min, m.p25, m.median, m.p75, m.max];
  const values = spread.slice(0, count);
  // Pad if needed
  while (values.length < count) {
    values.push(m.mean);
  }

  return values.map((v) => {
    let s = m.is_integer ? String(Math.round(v)) : v.toFixed(m.decimal_precision);
    if (m.is_currency && m.currency_symbol) s = `${m.currency_symbol}${s}`;
    if (m.is_percentage) s = `${s}%`;
    return s;
  });
}

function generateSyntheticDate(m: DateMeta, count: number): string[] {
  const minTs = Date.parse(m.min_date);
  const maxTs = Date.parse(m.max_date);
  if (isNaN(minTs) || isNaN(maxTs)) {
    return Array(count).fill(m.min_date || "2024-01-01");
  }

  const values: string[] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? minTs : minTs + (maxTs - minTs) * (i / (count - 1));
    const d = new Date(t);
    // Format based on detected format
    if (m.format.includes("HH:mm:ss")) {
      values.push(d.toISOString().replace("T", " ").slice(0, 19));
    } else if (m.format.includes("HH:mm")) {
      values.push(d.toISOString().replace("T", " ").slice(0, 16));
    } else {
      values.push(d.toISOString().split("T")[0]);
    }
  }
  return values;
}

function generateSyntheticCategorical(m: CategoricalMeta, count: number): string[] {
  // Pick from known values
  let pool: string[] = [];
  if (m.distinct_values && m.distinct_values.length > 0) {
    pool = m.distinct_values;
  } else if (m.top_values && m.top_values.length > 0) {
    pool = m.top_values.map((t) => t.value);
  }

  if (pool.length === 0) {
    // Fallback based on pattern
    if (m.detected_pattern === "email")
      pool = ["user1@example.com", "user2@example.com", "user3@example.com"];
    else if (m.detected_pattern === "url")
      pool = ["https://example.com/a", "https://example.com/b"];
    else if (m.detected_pattern === "uuid") pool = ["550e8400-e29b-41d4-a716-446655440000"];
    else pool = ["value_1", "value_2", "value_3", "value_4", "value_5"];
  }

  const values: string[] = [];
  for (let i = 0; i < count; i++) {
    values.push(pool[i % pool.length]);
  }
  return values;
}

function generateSyntheticBoolean(m: BooleanMeta, count: number): string[] {
  let trueVal: string;
  let falseVal: string;
  switch (m.representation) {
    case "0/1":
      trueVal = "1";
      falseVal = "0";
      break;
    case "yes/no":
      trueVal = "yes";
      falseVal = "no";
      break;
    default:
      trueVal = "true";
      falseVal = "false";
  }

  // Ratio-based distribution
  const total = m.true_count + m.false_count;
  const trueRatio = total > 0 ? m.true_count / total : 0.5;
  const values: string[] = [];
  for (let i = 0; i < count; i++) {
    values.push(i / count < trueRatio ? trueVal : falseVal);
  }
  return values;
}

function generateSyntheticRows(schema: CSVSchema): Record<string, string>[] {
  const count = MAX_SAMPLE_ROWS;

  // Generate synthetic values per column
  const columnValues: Record<string, string[]> = {};
  for (const col of schema.columns) {
    columnValues[col.name] = generateSyntheticValues(col, count);
  }

  // Assemble into rows
  const rows: Record<string, string>[] = [];
  for (let i = 0; i < count; i++) {
    const row: Record<string, string> = {};
    for (const col of schema.columns) {
      row[col.name] = columnValues[col.name][i];
    }
    rows.push(row);
  }
  return rows;
}

// ── Data section based on mode ────────────────────────────────────

function formatDataSection(schema: CSVSchema, mode: SchemaMode): string {
  if (mode === "sample") {
    const sampleRowsJson = JSON.stringify(schema.sample_rows.slice(0, MAX_SAMPLE_ROWS), null, 2);
    return `\n## Sample Rows\n${sampleRowsJson}`;
  }

  const syntheticRows = generateSyntheticRows(schema);
  const syntheticJson = JSON.stringify(syntheticRows, null, 2);
  return `\n## Sample Rows\n${syntheticJson}`;
}

// ── User prompt (initial query) ───────────────────────────────────

export function buildCodeGenUserPrompt(
  schema: CSVSchema,
  question: string,
  mode: SchemaMode = "metadata",
  workbookContext?: string,
  localFileContext?: string,
  sandboxMemoryGb?: string | null
): string {
  return `${buildCodeGenSchemaBlock(schema, mode, workbookContext, localFileContext, sandboxMemoryGb)}
## Question
${question}`;
}

/**
 * Geospatial code-gen guidance — the KD-tree / NAMED-REGION-polygon / memory-safe
 * recipe, included ONLY when the data has a real geometry column. Steers away from
 * the Overture failure modes: a non-existent GEOGRAPHY cast and O(n^2) distance
 * self-joins that time out. Exported so the self-correction RETRY path can
 * re-inject it — a first attempt gets it via the schema block, but a retry that
 * rebuilt the prompt from scratch would DROP it and "repair" a superlative by
 * downsampling (the exact regression that turned an all-buildings KD-tree into a
 * grid-cell approximation on the first California run).
 */
export function buildGeospatialGuidance(
  schema: CSVSchema,
  sandboxMemoryGb?: string | null
): string {
  const hasGeometryColumn = schema.columns.some((c) =>
    /^(geometry|geom|the_geom|wkb_geometry|geog|shape)$/i.test(c.name)
  );
  if (!hasGeometryColumn || schema.has_geojson) return "";
  const hasBboxColumn = schema.columns.some((c) => /^bbox$/i.test(c.name));
  const bboxTip = hasBboxColumn
    ? `\nThis dataset has a bbox STRUCT column (xmin/ymin/xmax/ymax). The geometry/WKB column is the LARGEST column — reading or decoding it for millions of rows over a remote S3 scan is the single dominant cost and can push a ~2-min scan past a 20-min timeout. So for point-based work, do NOT touch geometry at all: (1) FILTER on the bbox struct — bbox.xmin BETWEEN lon_min AND lon_max AND bbox.ymin BETWEEN lat_min AND lat_max — cheap scalar with predicate pushdown, NOT ST_X(ST_Centroid(geometry)) which decodes every geometry. (2) For the building's POINT (centroid, nearest-neighbor, point-in-polygon) derive it from the bbox struct: lon = (bbox.xmin+bbox.xmax)/2.0, lat = (bbox.ymin+bbox.ymax)/2.0 (or ST_Point of those). A building's bbox center is inside its footprint, so it is the correct locating point — and this NEVER reads the geometry column. Only decode geometry (ST_Centroid, ST_Area, ST_Length, distances on shapes) when you genuinely need the SHAPE, not just a point. But a bbox is a coarse PRE-filter, not a region boundary — see NAMED REGION below.`
    : "";
  return `\n## Geospatial analysis (spatial extension is loaded)
Read via read_parquet with spatial loaded, the geometry column is ALREADY a GEOMETRY value — use it DIRECTLY in spatial functions: ST_Centroid(geometry), ST_X(...), ST_Y(...), ST_Intersects(geometry, ...). Do NOT wrap it in ST_GeomFromWKB() or ST_GeomFromText() — those take a BLOB/VARCHAR and ERROR on a GEOMETRY ("No function matches ST_GeomFromWKB(GEOMETRY)"). Only use ST_GeomFromWKB when a column is a raw WKB BLOB.${bboxTip}
NAMED REGION = POLYGON, NOT A BOX — when the question names an administrative area (a state, county, country, city, neighborhood), a lat/lon bounding box is ONLY a coarse pre-filter, never the final filter: a rectangle around California also contains slices of Oregon, Nevada, Arizona, the Pacific and Mexico, so edge/extreme queries (most-isolated, northern-most, farthest-apart) will return points OUTSIDE the named area. Filter by the actual boundary polygon. On Overture, boundaries live in the divisions theme: read type=division_area from the SAME release as the source (swap \`theme=buildings/type=building\` → \`theme=divisions/type=division_area\` in the S3 path), select the area by ISO code where one exists — WHERE subtype='region' AND region='US-CA' for a state, country='US' for a whole country. For a CITY or COUNTY (no ISO code) match the NAME with the right subtype: WHERE subtype='locality' AND LOWER(names.primary) = LOWER('Seattle') for a city, subtype='county' for a county — and ALSO filter country (and region if known): locality names are homonyms across the planet (there is a Paris in Texas), and the extra predicates cost nothing. names.primary is a STRING — compare it directly; do NOT index it like a list: \`names['primary'][1]\` returns just the FIRST CHARACTER ('S'), so the match silently finds nothing, ST_Union_Agg returns NULL, ST_XMin(NULL) becomes nan, and the next query interpolates "BETWEEN nan AND nan" → cryptic DuckDB error + wasted retry.
BOUNDARY LOOKUP IS TWO-PHASE (MANDATORY — the divisions-side twin of the bbox rule above): division_area's geometry column holds every admin polygon on the planet, and a one-shot \`SELECT ST_Union_Agg(geometry) ... WHERE <name/subtype filters>\` reads that entire multi-GB column over S3 — a name predicate prunes NOTHING, and this single query is what turns a ~2-min analysis into a 20-min timeout. Phase A — find the extent WITHOUT touching geometry: SELECT MIN(bbox.xmin) AS xmin, MIN(bbox.ymin) AS ymin, MAX(bbox.xmax) AS xmax, MAX(bbox.ymax) AS ymax FROM read_parquet('...type=division_area/**') WHERE <your subtype/name/country filters> — bbox and names are tiny columns, so this runs in seconds even globally. Pull the four numbers into Python floats, but UNPACK SAFELY — a no-match returns a row of NULLs (MIN/MAX over zero rows is NULL), and \`xmin, ymin, xmax, ymax = float(row[0]), float(row[1]), …\` raises \`TypeError: float() argument must be … not 'NoneType'\` on the spot, BEFORE any assert on the next line can run (observed: a "San Francisco" lookup crashed here because the name/subtype filter matched nothing). Coerce with the preloaded \`safe_float()\` and check for None FIRST: \`ext = [safe_float(v) for v in row]; \` then \`if any(v is None for v in ext): raise ValueError("<region> boundary not found — check the subtype/name/country filters")\` and only then \`xmin, ymin, xmax, ymax = ext\`. If they come back None the name matched NO rows — fix the name filter (right subtype? homonym needs country/region?), never interpolate nan into SQL. Phase B — fetch the polygon bounded by those literals: the SAME read_parquet with the SAME filters PLUS \`bbox.xmin >= {xmin - 0.01} AND bbox.xmax <= {xmax + 0.01} AND bbox.ymin >= {ymin - 0.01} AND bbox.ymax <= {ymax + 0.01}\` (every matching row's bbox lies inside the Phase-A extent by construction; the margin is float-paranoia). Now the fat geometry column is read only from the few row groups near the target area. In Phase B, MATERIALIZE the boundary into a single-row temp table AND SIMPLIFY it in the same step: \`CREATE TEMP TABLE region AS SELECT ST_Simplify(ST_Union_Agg(geometry), 0.001) AS geom FROM read_parquet(...) WHERE <filters + bbox literals>\`. ST_Union_Agg collapses the SEVERAL rows a region often has (mainland + islands) into ONE geometry — never CROSS JOIN the raw multi-row result or you double-count/drop islands. ST_Simplify(…, 0.001) (~100m tolerance) is NOT optional for a state/county/country: a real admin boundary (California's coastline especially) has tens of thousands of vertices, and ST_Contains cost is vertices × points-tested, so the per-point test against the full-detail polygon over MILLIONS of buildings is itself a 20-min sink — simplifying cuts the vertex count ~10-50× at negligible accuracy for building-scale point tests. Materialize (CREATE TEMP TABLE), do NOT leave the polygon as a lazy Python relation you reference in a subquery — the temp table pins the simplified geometry so the per-row test reads it once from one small row, not re-planned into the scan. Phase B's bbox filter MUST use the Phase-A extent literals ({xmin}..{xmax}) VERBATIM — NEVER a hand-narrowed "sane window" you picked for a different reason (e.g. clamping the grid to contiguous-US lon[-125,-66] to dodge the antimeridian). A country's boundary is ONE multipolygon row whose OWN bbox spans the FULL country (USA bbox.xmin ≈ -180 via the Aleutians): a clamp like \`bbox.xmin >= -125\` then EXCLUDES that single row, ST_Union_Agg aggregates ZERO rows, geom comes back NULL, and \`ST_Contains(NULL, cell)\` is false for EVERY cell → "no candidate found in scope" with 0 in-region cells (OBSERVED: run returned occupied_cells_in_usa: 0 over 26,640 real cells). The grid/analysis window and the boundary-build window are DIFFERENT things — clamp the grid if you must, but build the polygon from the region's full Phase-A extent. GUARD IT: right after CREATE TEMP TABLE region, verify the polygon is real with an \`if … raise\` — NOT \`assert n_geom == 1\`: a post-processing pass STRIPS any assertion that compares to a literal number (\`assert x == 1\` → \`pass\`), so an ==guard is silently deleted and never runs. Use \`n_geom = duckdb.sql("SELECT count(*) FROM region WHERE geom IS NOT NULL").fetchone()[0]; if not n_geom: raise ValueError("region polygon is NULL — boundary build matched no rows (bbox filter too tight? clamped away the country row?)")\` — a NULL region must FAIL LOUD here (raise survives the strip), not silently reject all buildings downstream.
Then: the Phase-A extent IS your pre-filter box for the SOURCE table (no hardcoded box, no ST_XMin on the polygon needed) — apply it to bbox.* for cheap pushdown, and keep only rows where ST_Contains((SELECT geom FROM region), ST_Point((bbox.xmin+bbox.xmax)/2.0, (bbox.ymin+bbox.ymax)/2.0)) — test the bbox-center POINT, do NOT write ST_Contains(..., ST_Centroid(geometry)) which decodes the huge geometry column for every row. Use ST_Intersects against geometry only when area OVERLAP (not point-in-region) genuinely matters. Exact and still fast — the bbox prunes billions, the SIMPLIFIED polygon test runs on the survivors' cheap bbox points.
DuckDB has NO GEOGRAPHY type — NEVER cast \`::GEOGRAPHY\`. For distance in METERS between lon/lat points use ST_Distance_Sphere(ST_Point(lon, lat), ST_Point(lon, lat)); plain ST_Distance on lon/lat returns degrees, not meters.
F-STRING WHEN YOU INTERPOLATE — any \`duckdb.sql(...)\` that splices a computed Python value (a bbox bound like {xmin - 0.01}, a threshold, a top-N id list) into the SQL MUST be an f-string: \`duckdb.sql(f"""… WHERE bbox.xmin >= {xmin} …""")\`. A PLAIN (non-f) string leaves \`{xmin}\` literal and DuckDB fails with "Parser Error: syntax error at or near }" (observed: it killed a USA run's Phase-1 metadata query on the very first line). Conversely, if the SQL genuinely needs a LITERAL brace (a struct/map literal like {'a': 1}), double it as {{ }} inside an f-string.
CRITICAL — nearest/farthest-neighbor: a SQL distance self-join is O(n^2) and WILL time out, so do NOT self-join the full table. Instead build a KD-tree in Python (scipy.spatial.cKDTree, O(n log n)) over ALL points in scope (every building in the bounding box) — do not downsample; a KD-tree handles the full region and downsampling would miss the true extreme.
ROUTE BY SIZE FIRST — estimate N in scope from parquet_metadata (SUM(row_group_num_rows) over row groups whose bbox overlaps the region). If N FITS RAM (≲ ~30M points — BOTH the rowid+lon+lat coords frame AND the cKDTree.query(k=2) output arrays must fit under the cap) use the DIRECT KD-tree (skeleton next — this is Seattle ~0.3M, California ~13.7M). If N does NOT fit (whole USA ~130M, planet 2.5B) you CANNOT pull coords into pandas at all — a coords .df() over ~100M+ rows is THE OOM even "coords-only" — jump to PLANET-SCALE / DOESN'T-FIT below, which COUNTS in DuckDB and materializes only the tiny survivor set.
GATE THE DECISION IN CODE, DON'T EYEBALL IT — after a cheap COUNT(*) of the in-scope rows, call the preloaded \`assert_fits(N, cols=3)\` BEFORE the coords .df(). It raises (with the exact "switch to DOESN'T-FIT" instruction) when N cannot fit the container's REAL memory cap — so the direct path is taken only when it provably fits, and an over-scale region is forced onto the counting strategy on the FIRST attempt, not after a 25-minute OOM. If it raises, do NOT catch it and retry the direct approach with fewer columns — that is the DIVERGENCE TRAP (each retry trims a column, scans MORE, and OOMs later: observed 6→15→29 min across three attempts). Fewer columns does not help once N is the problem; only switching strategy does. GATE EVERY SCALING .df(), NOT JUST THE KD-TREE FRAME — this applies inside the DOESN'T-FIT path too, where the candidate/leaf reads scale with the data: whenever you are about to \`.df()\` a temp table you just built from the remote scan (a search-area / candidate_buildings pull, a leaf-cell read), first \`n = duckdb.sql("SELECT COUNT(*) FROM <that_table>").fetchone()[0]\` and \`assert_fits(n, cols=<#numeric cols you pull>)\`. The classic leak: an isolated cell's NEAREST occupied neighbour can be a dense METRO edge, so a search box around it returns MILLIONS of rows — that unguarded \`cand_df = duckdb.sql("SELECT rowid, lon, lat FROM candidate_buildings").df()\` is exactly what OOM-killed a USA run at ~18 min. If assert_fits raises there, sub-grid that one dense cell (a finer GROUP BY restricted to its bbox) and read only the sub-cell on the isolated point's facing side — never the whole box. ENFORCED — \`.df()\` IS HARD-CAPPED: a \`.df()\` that would pull too many rows into pandas RAISES immediately (before allocating), with a type-aware limit — generous for a numeric-only frame (rowid,lon,lat), tight for any frame carrying string/struct columns (id, names, class, height — these explode in pandas). So an unguarded region/point read fails fast telling you to reduce in DuckDB instead of OOM-killing the container. Do NOT fight it by chunking the same wide pull — obey it: keep the reduction in SQL (COUNT/GROUP BY/ORDER BY LIMIT k), \`.df()\` only the small result, pull ONLY numeric coordinates for a KD-tree, and hydrate attributes for the top-N winners afterward. Backstop (not a substitute for the gate): DuckDB is also capped to spill to disk, and a memory watchdog aborts if the pandas side still climbs past ~85% of the cap — so a doomed approach fails fast instead of burning 18 minutes.
CANONICAL SKELETON — for a bounded-region nearest/farthest-neighbor superlative, ADAPT THIS EXACT SHAPE rather than re-deriving it from the prose below (the prose explains WHY each line is written this way). The ONE line that OOM-kills the run when you get it wrong is the .df() feeding cKDTree: it is rowid+lon+lat and NOTHING else. Get this right on the FIRST attempt — an OOM here costs a multi-minute remote re-scan on retry.
    # region_buildings: TEMP TABLE already materialized (bbox pre-filter + ST_Contains bbox-center point),
    # with display cols kept IN DuckDB: SELECT (bbox.xmin+bbox.xmax)/2 AS lon, (bbox.ymin+bbox.ymax)/2 AS lat,
    #   id, names.primary AS name, class, height FROM data WHERE <bbox literals> AND ST_Contains(...)
    import numpy as np, duckdb
    from scipy.spatial import cKDTree
    from math import radians, cos
    n = duckdb.sql("SELECT COUNT(*) FROM region_buildings").fetchone()[0]
    assert_fits(n, cols=3, factor=4.0, what="the KD-tree coords frame")   # <== GATE: raises → take the DOESN'T-FIT path instead. Never wrap in try/except to force the direct path.
    c = duckdb.sql("SELECT rowid, lon, lat FROM region_buildings").df()   # <== 3 NUMERIC cols ONLY. Adding id/name/class/any string here IS the OOM.
    lat0 = radians(float(c["lat"].mean()))
    x = c["lon"].to_numpy() * cos(lat0) * 111320.0
    y = c["lat"].to_numpy() * 111320.0
    d, _ = cKDTree(np.column_stack([x, y])).query(np.column_stack([x, y]), k=2, workers=-1)
    nn_m = d[:, 1]                                       # nearest-neighbor distance, METERS
    N = 20
    top = np.argpartition(nn_m, -N)[-N:]
    top = top[np.argsort(nn_m[top])[::-1]]              # rank 1 = most isolated (largest NN distance)
    ids = ",".join(str(r) for r in c["rowid"].to_numpy()[top])
    # Hydrate ONLY the ~N winners by rowid, locally (never re-read the remote source):
    win = duckdb.sql(f"SELECT rowid, id, name, class, height, lon, lat FROM region_buildings WHERE rowid IN ({ids})").df()
    # WHERE-IN returns rows in ARBITRARY order — re-attach distances BY ROWID, do not zip by position:
    nn_by_rowid = {int(c["rowid"].to_numpy()[t]): float(nn_m[t]) for t in top}
    win["nn_dist_m"] = win["rowid"].map(nn_by_rowid)
    win = win.sort_values("nn_dist_m", ascending=False).reset_index(drop=True)   # rank 1 first
    # win now has the top-N with names/coords for results + the map layer (tag rank / is_winner).
    # WINNER RESULT DICT — coerce every numeric attribute with the preloaded safe_float()/safe_int();
    # NEVER hand-roll \`float(row['num_floors']) if row['num_floors'] and not np.isnan(...)\` — that throws
    # on None/blank/string/numpy values (a nullable field like num_floors/height IS often null) and has
    # crashed otherwise-successful runs at the finish line. e.g.
    #   best = win.iloc[0]
    #   results["answer"] = {"name": best["name"], "height_m": safe_float(best["height"]),
    #                        "num_floors": safe_int(best["num_floors"]), "nn_dist_m": safe_float(best["nn_dist_m"])}
ENGINE-FIRST — DuckDB streams and spills to disk, so it processes FAR more than fits in RAM; pandas does not. Do the heavy work (filter, aggregate, rank, distance) in DuckDB SQL and .df() only SMALL results. The sandbox has ${sandboxMemoryGb ? `a HARD memory cap of ~${sandboxMemoryGb} GB (the container is killed the instant it exceeds this)` : "limited RAM"}, and a large region can be MILLIONS of rows — loading them all (especially string columns) into pandas gets OOM-KILLED ("Killed"). The sandbox ALSO caps DuckDB's scan \`threads\` and sets \`preserve_insertion_order=false\` for you — because a BILLIONS-row REMOTE parquet scan OOMs on DuckDB's own per-thread row-group read/decompress buffers (which \`memory_limit\` does NOT bound), even when the GROUP-BY output is tiny (OBSERVED: 3x 20-25min OOMs on a USA superlative whose cells+KD-tree were provably small — the engine's scan buffers were the cause). Do NOT add \`SET threads=<high>\` — that re-introduces the scan-buffer OOM; the low default is deliberate.
MEMORY-SAFE KD-tree (MANDATORY on a large region — a wide .df() over millions of rows is THE OOM, and runs get killed for exactly this): the DataFrame you pass to cKDTree must contain ONLY numeric columns. Pull JUST the coordinates: df = duckdb.sql("SELECT lon, lat FROM region_buildings").df() — 2 numeric cols, so tens of millions fit. NEVER select id/class/subtype/height or any string/attribute column into this frame (e.g. do NOT write \`SELECT id, lon, lat, subtype, class, ... FROM region_buildings\`.df() — that is the OOM). Do NOT add \`row_number() OVER ()\` (or any un-partitioned/global window) to manufacture a key — an unpartitioned window is a single-threaded PIPELINE BREAKER that funnels the whole scan through one thread (measured: it turned a ~4-min materialize into an 18-min+ timeout). You don't need a manufactured key: pull DuckDB's free \`rowid\` alongside the coords (df = duckdb.sql("SELECT rowid, lon, lat FROM region_buildings").df()) — the top-N positions give you their rowids. Build the tree, take the top-N positions, THEN hydrate full attributes for ONLY those rows. \`rowid\` IS TABLE-ONLY — it exists ONLY because region_buildings is a MATERIALIZED temp table (CREATE TEMP TABLE …). It does NOT exist on a \`read_parquet(...)\` scan or a VIEW over one: \`SELECT rowid FROM read_parquet(...)\` (or from the \`data\` view) fails with "Binder Error: Referenced column rowid not found in FROM clause". So NEVER select rowid straight from the remote source — materialize into a temp table first, then rowid is valid on THAT table. And a rowid is per-scan positional, NOT a stable identity: a rowid from one scan is meaningless in any OTHER (re-)scan, so you can only use it to hydrate from the SAME temp table you read it from — to hydrate across a fresh read, key on the stable \`id\` column (or exact lon/lat) instead. For a BOUNDED region (a named region / bbox subset — the usual case), materialize the display columns INTO region_buildings in the ONE pass (a bounded subset, so affordable) — but they STAY in DuckDB: they reach pandas ONLY in the final winner hydration, NEVER in the KD-tree frame (which stays rowid+lon+lat). Hydrate the ~N winners LOCALLY by rowid, NAMING the columns (never SELECT *): duckdb.sql(f"SELECT id, names.primary AS name, class, height FROM region_buildings WHERE rowid IN ({top_ids})").df() — do NOT re-read the remote source. OVERTURE COLUMN TRAP: \`names\` is a nested STRUCT, not a string — select \`names.primary AS name\` (materialize it that way too: put \`names.primary AS name\` in region_buildings, never the raw \`names\`). Pulling the raw \`names\` struct into a DataFrame is a top OOM cause (a struct explodes into nested Python objects over millions of rows — this exact mistake OOM-killed a California run), and \`str(row['names'])\` on the struct is garbage. Same for any struct/list/map column: project the scalar field you need, never the container. A second REMOTE bbox read to hydrate a MOST-ISOLATED top-N is also a trap: those winners sit in wide-span row groups that defeat bbox pruning, so it re-reads huge row groups and times out (measured on California). Only a genuinely UNBOUNDED scan (no region) falls back to the second remote read. datasets['main'] gets the bounded top-N (or a sample), never the full frame.
PROJECT TO METERS FIRST — a KD-tree on raw lon/lat DEGREES is geographically distorted: a longitude degree shrinks with latitude, so degree-space distance mis-ranks neighbors (badly across a wide latitude span like a whole state/country) and can pick the WRONG most-isolated point. Convert to an equal-meter space before building the tree: lat0 = radians(mean_lat); x = lon * cos(lat0) * 111320; y = lat * 111320; cKDTree(column_stack([x, y])). Then the query distances are already ~meters (refine the reported top-N with an exact haversine/ST_Distance_Sphere if you want). NEVER build the tree on unscaled lon/lat.
EXTREME SCALE (coords don't even fit): do NN in DuckDB with a GRID self-join — bucket points into grid cells (FLOOR(lon/cell), FLOOR(lat/cell)), join a point only to points in the same or the 8 adjacent cells, and MIN(ST_Distance_Sphere(...)) per point. This is spatially correct and streams. For the FARTHEST/loneliest, points with no neighbor in the window are the candidates — widen the window (or increase the cell size) for those so their true NN distance is found, not dropped.
PLANET-SCALE / DOESN'T-FIT superlative (in-scope N too big to pull into pandas — USA ~130M, planet 2.5B): the fine-pass \`.df()\` is THE OOM (OBSERVED: a 10°-grid USA run climbed 28 min then OOM'd; "coords-only" does NOT save you because cKDTree.query(k=2) adds two more N×2 arrays — several GB). So NEVER materialize the tail — COUNT it in DuckDB, coarse-to-fine, and pull only the tiny survivor set into pandas. A most-isolated building sits in an empty disc, so you only need the sparse tail — and you FIND it by counting cells, not by reading points. (1) L0 DENSITY from footers (free, ~seconds): parquet_metadata('<same glob>') → per-row-group bbox (path_in_schema IN ('bbox, xmin','bbox, xmax','bbox, ymin','bbox, ymax'), CAST(stats_min/stats_max AS DOUBLE)) + row_group_num_rows → coarse density. Use it ONLY to bound WHERE to look (approximate — row-group boxes OVERLAP, so it is a conservative pre-filter, NOT the answer; do NOT read points by those boxes — that leaked and OOM'd). (2) EXACT CELL COUNTS via GROUP BY — the crux, and OOM-proof because it COUNTS, never materializes. Bucket each building's bbox-CENTER into a QUADTREE cell in METER space and GROUP BY it (s = cell size in metres, lat0 = region mean-lat in radians):
    cells = duckdb.sql(f'''SELECT
        floor(((bbox.xmin+bbox.xmax)/2.0)*cos({lat0})*111320.0/{s}) AS cx,
        floor(((bbox.ymin+bbox.ymax)/2.0)*111320.0/{s})            AS cy,
        count(*) AS occ
      FROM data WHERE <candidate-region bbox predicate>
      GROUP BY cx, cy''').df()
  Output = ONE row per occupied cell (tens of thousands), even if the read touched 100M+ buildings — DuckDB streams/spills the read, NOTHING lands in pandas. THIS is why it cannot OOM. Pick s SMALLER than the expected answer and LARGER than typical spacing; when unknown start coarse (≈ region_span/50) and let step 3 refine. (3) BRANCH-AND-BOUND on the small cells table (pure numpy, NO data reads): for each cell k = Chebyshev grid-distance to the nearest OTHER occupied cell (search over the occupied (cx,cy) set). UB = s·√2 if occ≥2 else (k+1)·s·√2 — THE occ CHECK IS THE #1 CORRECTNESS BUG WHEN OMITTED: a cell with occ≥2 holds two buildings INSIDE it (≤ one diagonal apart), so NO building in it can be more isolated than ~s·√2; ranking cells by cell-to-cell distance ALONE (using (k+1)·s·√2 for every cell) picks a REMOTE CLUSTER over a lone building (OBSERVED: "most isolated building in California" returned an offshore island's dock with a 103 m neighbour — an occ-MANY island cell that is merely far from the mainland — instead of a lone desert building kilometres from anything). The most-isolated building is ALMOST ALWAYS in an occ==1 cell; a high-occ cell, however remote, holds buildings close to EACH OTHER. Compute and prune by the occ-AWARE UB (\`ub = s*1.4142 if occ>1 else (k+1)*s*1.4142\`), never (k+1)·s·√2 for all cells — and if a candidate's exact NN comes back suspiciously small (≲ s·√2) for a "most isolated" query, it was a cluster, not the answer. Seed best-confirmed B by exact-computing (step 4) the cell with the largest (k−1)·s. KEEP cells with UB ≥ B, DROP the rest — every dense cell prunes once s·√2 < B. If little prunes (s too coarse, dense cells survive), REFINE: re-run the step-2 GROUP BY at s/2 restricted to the surviving cells' bboxes; repeat until survivors are few. (4) LEAF exact NN — this is a POINT-ANCHORED nearest-neighbour query per candidate, NOT a region materialization. A survivor cell holds ~1 isolated building q; you need the SINGLE nearest building to q, not all points in a ring. Do NOT read the whole ceil(UB/s) ring into pandas and do NOT accumulate rings across survivors (both OOM: an isolated q's nearest occupied neighbour may BE a dense metro edge, so its ring overlaps millions — OBSERVED, this exact leaf read OOM'd the USA run at ~28 min AFTER the counts succeeded). Instead: (a) read q's own cell's points (sparse → tiny). (b) Use the CELL COUNTS you already have (no data read) to find the nearest OTHER occupied cell to q by increasing Chebyshev radius. (c) Read ONLY that nearest occupied cell. If it is DENSE (high occ — a metro edge), do NOT read it whole: sub-grid THAT ONE cell (a finer GROUP BY restricted to its bbox) and read only the sub-cell on q's facing side — you need the nearest POINT, not the metro. (d) The candidate's NN = min distance from q to the points you actually read; a single point q vs a cell's points is O(cell) linear, NEVER an all-pairs cKDTree over the whole ring (that O(n²)/materialization is the trap). Keep a running best B; skip any survivor whose UB < B without reading. Read the neighbour cell UNFILTERED by the region polygon so a true nearest neighbour just across a border still counts (fixes the nearest-IN-region overstatement of a polygon-only KD-tree). Winner = max confirmed NN; top-K = K largest. Only q's cell + the one nearest occupied (sub-)cell per survivor reach pandas (a few thousand points TOTAL) → peak memory ≈ a small-region run, regardless of N. COUNTRY = POLYGON ON THE CELLS, NOT THE 100M BUILDINGS (the recurring "answered with a Canadian building" bug): for a named country/region, a per-row ST_Contains over 100M+ buildings in the coarse GROUP BY IS too slow — so the tempting shortcut is a raw bbox, but the USA bbox (lon[-180,-60], lat up to 72) blankets Canada, Mexico and Greenland, and the emptier Canadian Arctic then DOMINATES the isolation ranking (OBSERVED: "most isolated in the USA" over the raw box surfaces neighbouring-country buildings). Apply the polygon to the SMALL sets ONLY: (i) coarse-GROUP-BY over the bbox (fast, no polygon), (ii) then keep only IN-COUNTRY cells by ST_Contains-ing the ~thousands of occupied CELL centroids against the (simplified) region polygon — register the tiny cells table back into DuckDB, e.g. \`SELECT * FROM cells WHERE ST_Contains((SELECT geom FROM region), ST_Point(lon_c, lat_c))\` — BEFORE you rank candidates, and (iii) verify the final WINNER building is ST_Contains(region) (one point). Keep the NN NEIGHBOUR search UNFILTERED by the polygon so a nearest neighbour just across the border still counts. That is a few thousand + one polygon tests, never 100M — correct AND cheap. SCOPE TRAP: a region bbox crossing the antimeridian (USA + Aleutians) makes min(xmin)…max(xmax) span the globe — split at ±180 (or clamp the GRID to the main landmass, e.g. lon[-125,-66] for contiguous US) and rely on the cell polygon filter, never one raw bbox. BUT that grid clamp is for the GROUP-BY window ONLY — do NOT feed it into the boundary-polygon build's bbox filter: the country's single boundary row has bbox.xmin ≈ -180, so a -125 clamp drops it, ST_Union_Agg yields NULL, and every cell fails ST_Contains → 0 in-region cells and "no candidate" (OBSERVED exactly this). Build \`region\` from the country's FULL extent (see the two-phase BOUNDARY LOOKUP rule + its NULL-geom assert), then ST_Contains the clamped grid's cells against it. Set results["analysis_scope"] to the resolution reached + that the dense majority was excluded (it cannot hold an isolated outlier). This is the SPATIAL case of the EXTREME/SELECTIVE strategy (see SCAN STRATEGY) — a DENSE-selecting superlative flips it (keep HIGH-occ cells); a global AGGREGATE over every row genuinely needs the full scan → bound+disclose.
THE MAP MUST SHOW THE ANSWER — when you plot points on a map/scatter for a superlative and you SAMPLE for context (e.g. a random \`np.random.choice(..., 2000)\` of the millions, to show the NN-distance distribution), that uniform sample essentially NEVER contains the single most-extreme building — so the ACTUAL ANSWER is INVISIBLE on the map (observed: the most-isolated Seattle building, at the edge of Seward Park, was absent because it wasn't in the 2,000-point sample). Rules: (1) ALWAYS union the top-N winners (which you already have) INTO whatever point layer the map binds to — never hand the map a bare random sample. (2) TAG the winners with a field the chart can key on — e.g. \`rank\` (1..N) or \`is_winner\`=True — and color/size the layer by the metric so the winner visibly stands out (it is by definition the extreme value). (3) Prefer making the top-N the PRIMARY map layer (guaranteed to include the winner) with any sample as faint context underneath, rather than a sample that merely might contain it. The point of the map is to LOCATE the answer; a map that omits it has failed the question. (4) ATTACH per-building values (e.g. the NN distance) to the map SAMPLE by POSITION — index the arrays you already computed at the sample's row indices (\`sample_df["nn_m"] = nn_m[sample_idx]\`). NEVER build a Python dict/Series over ALL N rows to do it: \`{int(rowid[i]): float(nn_m[i]) for i in range(len(c))}\` is ~150 bytes PER ENTRY ≈ GIGABYTES at millions of rows — a pure-Python OOM that the .df() cap and assert_fits CANNOT see because it isn't a DataFrame (OBSERVED: a full-N dict built just to label a 2,000-row sample OOM'd a 14M-building California run at 90% of a 5 GB cap, on top of the coords frame + KD-tree already resident). The same rule holds for hydrating winners — you already have their positions; index, don't build an N-sized map.
SCOPE DISCLOSURE — if you bound the analysis (a region rather than everything asked, an approximate/sampled method, or a very large count), set results["analysis_scope"] to a short sentence stating exactly what was covered and how (e.g. "Analyzed all 11,240,338 buildings inside the California boundary polygon (Overture division_area, region=US-CA) via an exact KD-tree."). If you filtered by a raw bounding box rather than the true boundary, SAY SO explicitly ("...within the California bounding box, which includes some neighboring-state points") — do not imply the result is confined to the named area when it is not. Report the actual number of points analyzed.\n`;
}

/**
 * The schema/context block shared by the single-shot and chat code-gen prompts.
 * It's stable for a given dataset, so callers send it as a cached content part
 * (the prefix) with the variable question appended as a separate, uncached part
 * — that's the Anthropic prompt-cache breakpoint for the user prompt. Returns
 * the exact text that previously lived inline in buildCodeGenUserPrompt minus
 * the trailing "## Question" tail.
 */
export function buildCodeGenSchemaBlock(
  schema: CSVSchema,
  mode: SchemaMode = "metadata",
  workbookContext?: string,
  localFileContext?: string,
  sandboxMemoryGb?: string | null
): string {
  const columnDescriptions = formatColumns(schema, mode);

  const geomType = schema.geojson_geometry_type ?? "unknown";
  const isPolygonGeom = geomType === "Polygon" || geomType === "MultiPolygon";
  const geojsonSection = schema.has_geojson
    ? `\n## GeoJSON Source
This data was uploaded as a GeoJSON file. Geometry type: ${geomType}.
A GeoJSON file is available at "/data/input.geojson" alongside the tabular CSV.${
        isPolygonGeom
          ? `\nIMPORTANT: This contains polygon geometry. Pass the full GeoJSON FeatureCollection as chart_data["geojson"]. Do NOT extract centroids or use point markers — render the actual polygon boundaries.`
          : ""
      }\n`
    : "";

  const workbookSection = workbookContext ? `\n## Workbook Context\n${workbookContext}\n` : "";

  const correlationSection =
    schema.correlations && schema.correlations.length > 0
      ? `\n## Notable Correlations\n${schema.correlations.map((c) => `- ${c.col_a} ↔ ${c.col_b}: r=${c.pearson}`).join("\n")}\n`
      : "";

  const domainSection =
    schema.detected_domain && schema.detected_domain !== "general"
      ? `\nDetected data domain: ${schema.detected_domain}\n`
      : "";

  const warehouseSection =
    schema.source_type === "warehouse"
      ? `\nData source: ${schema.warehouse_type} warehouse, table: ${schema.warehouse_table}
Column types are database-native (high fidelity). The data has been loaded as CSV at /data/input.csv.\n`
      : "";

  const localFileSection = localFileContext ? `\n## Data Location\n${localFileContext}\n` : "";

  // Geospatial guidance (KD-tree / polygon / memory-safe recipe) — only when the
  // data has a geometry column. Extracted so the retry path re-injects the SAME
  // text (see buildGeospatialGuidance).
  const spatialSection = buildGeospatialGuidance(schema, sandboxMemoryGb);

  const headerLabel = schema.source_type === "warehouse" ? "Data Schema" : "CSV Schema";

  return `## ${headerLabel}
Filename: ${schema.filename}
Rows: ${schema.row_count}${domainSection}${warehouseSection}${localFileSection}
Columns:
${columnDescriptions}
${formatDataSection(schema, mode)}
${correlationSection}${geojsonSection}${spatialSection}${workbookSection}`;
}

// ── User prompt (chat follow-up) ──────────────────────────────────

function formatConversationTurns(turns: ConversationTurn[]): string {
  return turns
    .map((turn, i) => {
      const lines: string[] = [`### Turn ${i + 1}: "${turn.question}"`];

      const summary = turn.analysisSummary;
      if (summary) {
        const resultEntries = Object.entries(summary.resultKeys ?? {});
        if (resultEntries.length > 0) {
          lines.push(
            `Computed results: ${resultEntries.map(([k, t]) => `${k} (${t})`).join(", ")}`
          );
        }

        const chartEntries = Object.entries(summary.chartDataShapes ?? {});
        if (chartEntries.length > 0) {
          lines.push("Computed chart data:");
          for (const [k, shape] of chartEntries) {
            lines.push(`  - ${k}: ${shape.rows} rows, columns [${shape.columns.join(", ")}]`);
          }
        }
      }

      if (turn.specSummary) {
        lines.push(`Dashboard showed:\n${turn.specSummary}`);
      }

      return lines.join("\n");
    })
    .join("\n\n");
}

/** The "Prior Analysis Context" block for chat follow-ups (empty when none). */
export function buildConversationHistorySection(turns: ConversationTurn[]): string {
  if (turns.length === 0) return "";
  return `## Prior Analysis Context
The user is asking a follow-up question. Here is what was analyzed previously:

${formatConversationTurns(turns)}

Generate fresh code that reads the same source data and addresses the new question.
Build on the prior analysis: if the user references previous results (e.g. "break that down by region", "also show trends"), use the context above to understand what "that" refers to and what was already computed.

`;
}

// ── Workbook context builder ──────────────────────────────────────

/**
 * Sanitize a sheet name for use as a file name.
 * Replaces spaces and special chars with underscores, keeps alphanumeric + dash + dot.
 */
export function sanitizeSheetName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_\-]/g, "_").replace(/_+/g, "_");
}

/**
 * Build workbook context string for LLM prompts.
 * @param sheetPaths - map of sheet name → exact file path in the sandbox
 *   When provided, the LLM is told exactly where each file lives.
 *   The first entry is the primary sheet at /data/input.csv.
 */
export function buildWorkbookContext(
  manifest: WorkbookManifest,
  mode: SchemaMode,
  sheetPaths?: Map<string, string>
): string {
  const lines: string[] = [];
  lines.push(
    `This workbook has ${manifest.sheets.length} sheets. The user wants cross-sheet analysis.`
  );
  lines.push("");

  // List exact file paths so the LLM doesn't have to guess
  if (sheetPaths && sheetPaths.size > 0) {
    lines.push("### File Paths");
    for (const [sheetName, filePath] of sheetPaths) {
      lines.push(`- "${sheetName}" → ${filePath}`);
    }
    lines.push("");
  }

  for (const sheet of manifest.sheets) {
    const pathNote = sheetPaths?.get(sheet.name);
    const pathSuffix = pathNote ? ` — file: ${pathNote}` : "";
    lines.push(`### Sheet: ${sheet.name} (${sheet.schema.row_count} rows${pathSuffix})`);
    lines.push("Columns:");
    for (const col of sheet.schema.columns) {
      if (mode === "metadata") {
        lines.push(formatColumnMeta(col));
      } else {
        lines.push(formatColumnSample(col));
      }
    }
    lines.push("");
  }

  if (manifest.relationships.length > 0) {
    lines.push("### Detected Relationships");
    for (const rel of manifest.relationships) {
      if (rel.confidence < 0.5) continue;
      const pkFk = rel.isPrimaryKeyCandidate
        ? rel.isForeignKeyCandidate
          ? ", PK\u2194FK"
          : ", PK"
        : rel.isForeignKeyCandidate
          ? ", FK"
          : "";
      lines.push(
        `- ${rel.sourceSheet}.${rel.sourceColumn} \u2194 ${rel.targetSheet}.${rel.targetColumn} (${rel.matchType}, confidence: ${rel.confidence.toFixed(2)}${pkFk})`
      );
    }
  }

  return lines.join("\n");
}

// ── Retry prompt ──────────────────────────────────────────────────

/**
 * Build a retry prompt that includes ALL prior failed attempts, not just the
 * most recent one. Helps the LLM avoid going in circles — each attempt adds
 * a constraint of "this thing didn't work either."
 *
 * The list is in attempt order: priorAttempts[0] is the original failed
 * code, priorAttempts[N-1] is the most-recent failed retry.
 */
export function buildRetryPromptMulti(
  priorAttempts: { code: string; error: string }[],
  schema?: CSVSchema
): string {
  if (priorAttempts.length === 0) {
    throw new Error("buildRetryPromptMulti requires at least one prior attempt");
  }

  const schemaContext = schema
    ? `\n## Available Columns\nFilename: ${schema.filename} (${schema.row_count} rows)\n${schema.columns.map((c) => `- ${c.name} (${c.dtype})`).join("\n")}\n\nUse EXACTLY these column names — they are case-sensitive.\n`
    : "";

  const attemptHistory = priorAttempts
    .map((a, i) => {
      const label =
        priorAttempts.length === 1
          ? "Your previous code"
          : i === priorAttempts.length - 1
            ? `Attempt ${i + 1} (most recent)`
            : `Attempt ${i + 1}`;
      // Truncate each prior code/error to keep total prompt size sane
      const codeBlock =
        a.code.length > 4000 ? a.code.slice(0, 4000) + "\n# ...[truncated]" : a.code;
      const errBlock =
        a.error.length > 1500 ? a.error.slice(0, 1500) + "\n[...truncated]" : a.error;
      return `### ${label}\n\nCode:\n\`\`\`python\n${codeBlock}\n\`\`\`\n\nError:\n\`\`\`\n${errBlock}\n\`\`\``;
    })
    .join("\n\n");

  const reflectionPrompt =
    priorAttempts.length > 1
      ? `\n\n## Reflection\nYou have already tried ${priorAttempts.length} times. Each prior attempt failed for the reason shown. Do NOT repeat the same fix that already failed — review the errors and make a substantively different change.\n`
      : "";

  return `Your previous code failed. Fix it.

${attemptHistory}${schemaContext}${reflectionPrompt}`;
}

/**
 * Static retry guidance ("Common fixes"). Lives in the retry SYSTEM prompt (and
 * is cached) rather than the per-attempt user prompt, so it isn't re-billed on
 * every retry / sub-question. Appended after the base retry system instruction.
 */
export const RETRY_GUIDANCE = `## Common fixes
- **KeyError / column not found**: use the EXACT column name from the Available Columns in the prompt (case-sensitive). For case-insensitive matching: \`col = next((c for c in df.columns if c.lower() == "target".lower()), None)\`.
- **TypeError on aggregation**: column is stored as strings — coerce with \`pd.to_numeric(df[col], errors="coerce")\` first.
- **ValueError: could not convert string to float**: clean before parsing — strip currency symbols, commas: \`df[col].str.replace(r'[$,]', '', regex=True).astype(float)\`.
- **NaN in JSON output / serialization / to_dict errors**: do NOT serialize yourself — call the preloaded \`write_output(results=, chart_data=, datasets=)\`; it coerces NaN/Inf/numpy/Timestamp/Decimal for you.
- **"no results or chart data" (degenerate/empty output)**: you must call \`write_output(...)\` with at least one entry in BOTH \`results\` and \`chart_data\`. If a filter emptied the frame, check \`df[col].unique()\` and widen it; then populate and emit.
- **qcut "Bin edges must be unique" / ValueError on binning**: use the preloaded \`safe_qcut(series, q)\` instead of \`pd.qcut\`.
- **TypeError on .diff()/.pct_change()/.corr()**: wrap with the preloaded \`numeric(df)\` (or \`to_num(series)\`) first — the frame has non-numeric columns.
- **AttributeError 'Series' object has no attribute X**: you're calling a DataFrame method on a Series — use \`df[[col1, col2]]\` (note double brackets) to get a DataFrame.
- **FileNotFoundError for sheets**: use the exact paths from the workbook context.
- **Empty result / 0 rows after filter**: your filter may be too strict; check the actual values in the column with \`df[col].unique()\` first.
- **AssertionError**: DELETE the failing \`assert\`. Do NOT assert a computed value equals a hard-coded number (e.g. \`assert corr == 0.785\`) — it crashes on valid data. Just compute the value and put it in the output. Keep only structural checks like \`assert len(df) > 0\`.
- **ImportError / cannot import name**: you used a function that doesn't exist (e.g. \`auc_score\` — it's \`sklearn.metrics.auc\`). Use the correct name, or compute it with numpy/pandas/scipy instead of a guessed import.
- **Code timed out / Out of memory ("Killed" / OOM)**: the dataset is large. The fix DEPENDS ON THE QUESTION — do NOT reflexively downsample:
  - For a SUPERLATIVE / nearest-neighbor / most-isolated / farthest / top-N-by-a-derived-measure question, sampling or \`df.head()\` would DROP the very extreme you are asked to find — NEVER do it. Keep ALL rows in scope and fix memory the RIGHT way: do the heavy filtering/aggregation in DuckDB SQL (it spills to disk), pull ONLY numeric coordinate columns into pandas for the KD-tree (\`SELECT rowid, lon, lat …\` — 2-3 numeric cols, so tens of millions fit), NEVER a string/struct column (the raw \`names\` struct is a top OOM cause), then hydrate the ~N winners by rowid (bounded region) or by id/coordinates (unbounded). Follow the Geospatial analysis recipe above exactly.
    - IF YOU ALREADY DID coordinates-only AND STILL OOM'd: the region is simply too big for an in-memory KD-tree — trimming another column will NOT help and retrying the direct approach will just OOM again later (the divergence trap). SWITCH to the DOESN'T-FIT counting strategy (COUNT per grid cell in DuckDB, branch-and-bound, pull only the sparse survivors). Gate it next time with \`assert_fits(N, cols=3)\` right after your COUNT(*), before the coords .df(), so this decision happens up front instead of after a kill.
  - For a plain distribution/plot that genuinely just needs fewer points, THEN aggregate in SQL or take a uniform sample — and disclose it in results["analysis_scope"].

Fix the code and return only the corrected Python script. No markdown fencing, no explanation.`;
