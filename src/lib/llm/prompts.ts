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
} from "@/lib/types";
import { MAX_SAMPLE_ROWS } from "@/lib/constants";

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
- Year-over-year or month-over-month comparisons are often more useful than raw trends.`;

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
  domain?: DataDomain
): string {
  const metadataNote =
    mode === "metadata"
      ? "\n- Column metadata (types, statistics, distributions, patterns) is provided instead of sample data. Use this metadata to understand value ranges, formats, and data characteristics."
      : "";

  return `You are a data analyst. You will be given a CSV schema and a user question.

Your job is to write a single Python script that:
1. Reads the CSV from "/data/input.csv"
2. Performs the necessary analysis using pandas, numpy, scipy
3. Writes a single JSON object to the file "/data/output.json" with this exact structure:
   {
     "results": { ... },       // computed values, aggregations, statistics
     "chart_data": { ... },    // objects with arrays formatted for chart components
     "images": { "key": "base64..." },  // any matplotlib/seaborn output (optional)
     "datasets": { "main": [ ... ] }    // the working dataset as row objects (up to 5000 rows)
   }

Rules:
- IMPORTANT: Only use data that exists in the CSV. Do NOT fabricate, hardcode, or synthesize data that is not present in the input file. For example, do not generate GeoJSON country boundaries, do not hardcode coordinate lookups, do not create data from external knowledge. Every value in chart_data must be derived from the CSV columns.${metadataNote}
- Use pandas for all data manipulation.
- For charts that the UI can handle natively (bar, line, area, pie, scatter, histogram, box plot, heatmap, violin), return the data as JSON under chart_data. Do NOT generate matplotlib for these.
- For histograms: return raw numeric data rows under chart_data so the client can bin them. Include the value column and any grouping column.
- For box plots: return raw data rows with the value column and grouping column under chart_data.
- For heatmaps/correlation matrices: return {z: number[][], x_labels: string[], y_labels: string[]} under chart_data.
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
- For stream charts (StreamChart): return rows where each row has a value for each category key, under chart_data.
- For marimekko charts (MarimekkoChart): return rows with id_key, value_key, and dimension value columns under chart_data.
- Use matplotlib/seaborn ONLY for truly custom visualizations that cannot be expressed with the above chart types. Save as base64 PNG. The UI has native support for: bar, line, area, pie, scatter, histogram, box, violin, heatmap, radar, bump, chord, sankey, treemap, sunburst, marimekko, calendar, stream, waterfall, ridgeline, dumbbell, slope, beeswarm, SHAP beeswarm, confusion matrix, ROC curve, parallel coordinates, bullet, decision tree, candlestick, 3D scatter, 3D surface, globe, and map.
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
- DEFENSIVE CODING — always verify columns exist before using them:
  - After reading the CSV, check df.columns to confirm expected column names are present.
  - Use case-insensitive lookup when column names might differ in casing: match = [c for c in df.columns if c.lower() == expected.lower()].
  - When a column is not found, try partial/fuzzy matching before giving up: match = [c for c in df.columns if expected.lower() in c.lower()].
  - Convert numeric columns explicitly: pd.to_numeric(df[col], errors="coerce") — do not assume dtype.
  - For correlation, PCA, or any operation requiring numeric data, select numeric columns first: df.select_dtypes(include="number"). Never call df.corr() on a DataFrame with string columns.
  - When aggregating (sum, mean, etc.), verify the result is not NaN/0 due to type issues. If a numeric column is stored as strings with formatting (e.g. "$1,234"), strip non-numeric characters first: df[col] = pd.to_numeric(df[col].astype(str).str.replace(r'[^0-9.\-]', '', regex=True), errors='coerce').
  - For workbook joins, verify the join produced rows: assert len(merged) > 0 or fall back gracefully.
- Do NOT use print() at all. Write the final JSON output to "/data/output.json" using: json.dump(output, open("/data/output.json", "w"), default=str, allow_nan=False). Replace NaN/None values in DataFrames before serialization: df = df.fillna("") or df = df.where(df.notna(), None).
- Do not install packages. Available: pandas, numpy, scipy, matplotlib, seaborn, scikit-learn.
- Always include datasets.main in the output: the working DataFrame converted to row-objects via df.head(5000).to_dict(orient="records"). This enables client-side interactive filtering. If you filter the data for the analysis, use the ORIGINAL unfiltered DataFrame for datasets.main.${
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
- Include units in result keys where possible (e.g. "revenue_usd", "growth_pct", "volume_shares").${domain ? `\n${buildDomainLayer(domain)}` : ""}
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
  workbookContext?: string
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

  const headerLabel = schema.source_type === "warehouse" ? "Data Schema" : "CSV Schema";

  return `## ${headerLabel}
Filename: ${schema.filename}
Rows: ${schema.row_count}${domainSection}${warehouseSection}
Columns:
${columnDescriptions}
${formatDataSection(schema, mode)}
${correlationSection}${geojsonSection}${workbookSection}
## Question
${question}`;
}

// ── User prompt (chat follow-up) ──────────────────────────────────

export function buildCodeGenChatPrompt(
  schema: CSVSchema,
  question: string,
  history: string[],
  mode: SchemaMode = "metadata",
  workbookContext?: string
): string {
  const columnDescriptions = formatColumns(schema, mode);

  const historySection =
    history.length > 0
      ? `## Conversation Context
The user has asked the following questions in this conversation (most recent last):
${history.map((q, i) => `${i + 1}. ${q}`).join("\n")}

The current question may be a follow-up. Consider previous questions for context (e.g. "change that to a bar chart" refers to the previous analysis, "also show trends" means add to what was discussed).

`
      : "";

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

  const headerLabel = schema.source_type === "warehouse" ? "Data Schema" : "CSV Schema";

  return `${historySection}## ${headerLabel}
Filename: ${schema.filename}
Rows: ${schema.row_count}${domainSection}${warehouseSection}
Columns:
${columnDescriptions}
${formatDataSection(schema, mode)}
${correlationSection}${geojsonSection}${workbookSection}
## Question
${question}`;
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

export function buildRetryPrompt(originalCode: string, error: string, schema?: CSVSchema): string {
  const schemaContext = schema
    ? `\n## Available Columns\nFilename: ${schema.filename} (${schema.row_count} rows)\n${schema.columns.map((c) => `- ${c.name} (${c.dtype})`).join("\n")}\n\nUse EXACTLY these column names — they are case-sensitive.\n`
    : "";

  return `Your previous code failed with this error:

\`\`\`
${error}
\`\`\`
${schemaContext}
Here was your code:
\`\`\`python
${originalCode}
\`\`\`

Common fixes:
- KeyError / column not found: check the Available Columns list above for the exact column name (case-sensitive). Use case-insensitive lookup if needed.
- TypeError on aggregation: the column may be stored as strings — use pd.to_numeric(df[col], errors="coerce") first.
- NaN in JSON output: use df.fillna("") or df.fillna(0) before serialization.
- FileNotFoundError for sheets: use the exact paths from the workbook context.

Fix the code and return only the corrected Python script. No markdown fencing, no explanation.`;
}
