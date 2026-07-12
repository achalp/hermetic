/**
 * Single-shot dashboard composition — extracted from the Ask route so it can be
 * shared with the Investigate "lookup" fast-path (a follow-up the classifier
 * judged shallow enough to answer with one pass instead of a full multi-step
 * investigation). Keeping it here makes the deterministic, highest-risk parts
 * (the conditional compose prompt; dataset/filterable detection; the
 * finalize-and-inject stream loop) unit-testable without a live LLM call.
 *
 * `buildDashboardComposeRequest` is pure: given an execution result + options it
 * returns the compose `userPrompt` + `customRules` and the dataset analysis the
 * stream step needs. It is a thin assembler over per-section builders
 * (`analyzeDatasets`, the `build*Section` functions, `buildComposeRules`) so
 * each concern — filterable-column detection, sample flagging, drill-down
 * framing, the rules catalog — can be read and changed in isolation.
 * `composeAndStreamDashboard` runs the LLM + streams the finalized spec.
 */

import { streamText } from "ai";
import { getModel, cachedSystem } from "@/lib/llm/client";
import { catalog } from "@/lib/catalog";
import { LLM_MAX_OUTPUT_TOKENS } from "@/lib/constants";
import { getPurposePrompt } from "@/lib/purpose-prompts";
import { createSpecFinalizer } from "@/lib/llm/finalize-spec-stream";
import { type ValidStateKeys } from "@/lib/llm/resolve-placeholders";
import { auditComputedKeys, type PatchLike } from "@/lib/pipeline/computed-key-audit";
import {
  collectNarrativeStrings,
  collectGroundedValues,
  verifyGrounding,
} from "@/lib/pipeline/grounding";
import { logger } from "@/lib/logger";
import type {
  SandboxExecutionResult,
  CSVSchema,
  SchemaMode,
  ConversationTurn,
  FilterValue,
} from "@/lib/types";

export interface DrillDownContext {
  parent_question: string;
  filter_column: string;
  filter_value: FilterValue;
  segment_label: string;
  chart_title: string | null;
  /** Additional filters AND-combined with the primary filter (2D / multi-select). */
  additional_filters?: { column: string; value: FilterValue }[] | null;
}

export interface DashboardComposeOpts {
  question: string;
  schema: CSVSchema;
  schemaMode: SchemaMode;
  purpose: string;
  priorTurns: ConversationTurn[];
  drillDownContext?: DrillDownContext | null;
  workbookContext?: string | null;
}

/**
 * Max rows shipped to the client for interactive filtering. A dataset AT this
 * size is assumed to be a `head(cap)` truncation (a sample), not the complete
 * result — so client-side re-aggregation of it is treated as approximate.
 */
export const INTERACTIVE_ROW_CAP = 5000;

export interface DashboardAnalysis {
  useDataController: boolean;
  mainDataset: Record<string, unknown>[] | undefined;
  imagePlaceholders: Record<string, string>;
  /**
   * Non-null when /datasets/main is (or may be) a SAMPLE of a larger result, so
   * client-side filtered aggregations are approximate. Rendered as a caveat on
   * the DataController and used to steer headline stats to exact $result values.
   */
  sampleNote: string | null;
}

export interface DashboardComposeRequest {
  userPrompt: string;
  customRules: string[];
  analysis: DashboardAnalysis;
}

// ── Dataset analysis ─────────────────────────────────────────────────

interface DatasetColumnInfo {
  name: string;
  distinct: number;
  sample: string[];
}

/** DashboardAnalysis plus the column detail the prompt sections need. */
interface DatasetAnalysis extends DashboardAnalysis {
  datasetColumns: DatasetColumnInfo[];
  filterableColumns: DatasetColumnInfo[];
}

/**
 * Inspect the execution result's datasets/results/images: detect filterable
 * columns (categorical, <15 distinct), decide whether a DataController is
 * warranted, flag a sampled /datasets/main, and build the image-placeholder
 * map. Pure derivation — everything downstream (prompt sections, rules,
 * stream-time injection) keys off this one analysis.
 */
function analyzeDatasets(executionResult: SandboxExecutionResult): DatasetAnalysis {
  const datasets = executionResult.datasets;
  const mainDataset = datasets?.main;
  const hasDataset =
    !!mainDataset && mainDataset.length > 0 && mainDataset.length <= INTERACTIVE_ROW_CAP;

  // Detect filterable columns (categorical with <15 distinct values)
  let datasetColumns: DatasetColumnInfo[] = [];
  if (hasDataset && mainDataset) {
    const allKeys = Object.keys(mainDataset[0] ?? {});
    datasetColumns = allKeys.map((col) => {
      const values = [...new Set(mainDataset.map((r) => String(r[col] ?? "")))].filter(Boolean);
      return { name: col, distinct: values.length, sample: values.slice(0, 8) };
    });
  }
  const filterableColumns = datasetColumns.filter((c) => c.distinct >= 2 && c.distinct <= 15);
  const useDataController = hasDataset && filterableColumns.length > 0;

  // Is /datasets/main a SAMPLE of a larger result? We can't always be sure, so
  // flag it when (a) the analysis explicitly says so, or (b) it sits exactly at
  // the interactive cap — the tell-tale of a head(cap) truncation. When flagged,
  // client-side filtered aggregations are approximate and get a visible caveat.
  const resultsObj = executionResult.results as Record<string, unknown>;
  const explicitSampleNote =
    typeof resultsObj?._sample_note === "string" ? resultsObj._sample_note : null;
  const mainTotal = typeof resultsObj?._main_total === "number" ? resultsObj._main_total : null;
  const flaggedSample =
    resultsObj?._main_sampled === true || explicitSampleNote !== null || mainTotal !== null;
  const mainMaybeSampled =
    useDataController && (mainDataset!.length >= INTERACTIVE_ROW_CAP || flaggedSample);
  const ofTotal = mainTotal ? ` of ${mainTotal.toLocaleString()}` : "";
  const sampleNote: string | null = mainMaybeSampled
    ? (explicitSampleNote ??
      `Interactive filters and per-group figures below are computed on a sample of ${mainDataset!.length.toLocaleString()}${ofTotal} rows. Unfiltered headline figures reflect the complete dataset.`)
    : null;

  // Build image placeholder map: LLM uses placeholder keys, we replace with real base64
  const imagePlaceholders: Record<string, string> = {};
  for (const key of Object.keys(executionResult.images)) {
    imagePlaceholders[key] = `data:image/png;base64,${executionResult.images[key]}`;
  }

  return {
    useDataController,
    mainDataset,
    imagePlaceholders,
    sampleNote,
    datasetColumns,
    filterableColumns,
  };
}

// ── Shape/size description helpers (pure) ────────────────────────────

/**
 * Describe chart_data shape (key names, column types, row counts, sample rows)
 * so the LLM can choose the right component without receiving full data arrays.
 */
function describeShape(val: unknown, includeSamples: boolean): unknown {
  if (Array.isArray(val)) {
    if (val.length === 0) return { _type: "array", rows: 0 };
    const sample = includeSamples ? val.slice(0, 2) : undefined;
    const first = val[0];
    if (typeof first === "object" && first !== null) {
      const cols: Record<string, string> = {};
      for (const [k, v] of Object.entries(first)) {
        cols[k] = typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string";
      }
      return sample
        ? { _type: "array", rows: val.length, columns: cols, sample }
        : { _type: "array", rows: val.length, columns: cols };
    }
    return sample
      ? { _type: "array", rows: val.length, valueType: typeof first, sample }
      : { _type: "array", rows: val.length, valueType: typeof first };
  }
  if (typeof val === "object" && val !== null) {
    const described: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      described[k] = describeShape(v, includeSamples);
    }
    return described;
  }
  return val; // scalars pass through
}

/** Type-only view of the results object, for metadata mode (no raw values). */
function describeResultsSchema(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) {
      out[key] = { type: "null" };
    } else if (typeof val === "number") {
      out[key] = { type: "number", is_integer: Number.isInteger(val) };
    } else if (typeof val === "boolean") {
      out[key] = { type: "boolean" };
    } else if (typeof val === "string") {
      out[key] = { type: "string" };
    } else if (Array.isArray(val)) {
      out[key] = {
        type: "array",
        length: val.length,
        element_type: val.length > 0 ? typeof val[0] : "unknown",
      };
    } else if (typeof val === "object") {
      out[key] = { type: "object", keys: describeResultsSchema(val as Record<string, unknown>) };
    }
  }
  return out;
}

/**
 * Shrink an oversized value to fit `maxChars` of JSON — arrays get a marked
 * `_truncated` sample, objects keep whole leading entries, scalars are sliced.
 */
function truncateValue(val: unknown, maxChars: number): unknown {
  if (Array.isArray(val)) {
    for (let limit = Math.min(val.length, 50); limit >= 5; limit = Math.floor(limit / 2)) {
      const sliced = val.slice(0, limit);
      const json = JSON.stringify(sliced);
      if (json.length <= maxChars) {
        if (limit < val.length) {
          return { _truncated: true, _total: val.length, _sample: sliced };
        }
        return sliced;
      }
    }
    return { _truncated: true, _total: val.length, _sample: val.slice(0, 3) };
  }
  const json = JSON.stringify(val);
  if (json.length <= maxChars) return val;
  if (typeof val === "object" && val !== null) {
    const entries = Object.entries(val as Record<string, unknown>);
    const trimmed: Record<string, unknown> = {};
    let remaining = maxChars - 50;
    for (const [k, v] of entries) {
      const s = JSON.stringify(v);
      if (s.length <= remaining) {
        trimmed[k] = v;
        remaining -= s.length;
      } else {
        trimmed[k] = truncateValue(v, Math.max(remaining, 200));
        break;
      }
    }
    return trimmed;
  }
  return String(val).slice(0, maxChars);
}

// ── Prompt section builders ──────────────────────────────────────────
// Each returns a complete block (conditional ones include their own leading
// blank lines and return "" when not applicable), so the assembler is a plain
// concatenation.

/** Question + results (schema or values) + chart-data shapes + image keys. */
function buildCorePrompt(
  executionResult: SandboxExecutionResult,
  question: string,
  schemaMode: SchemaMode,
  useDataController: boolean
): string {
  const imageKeys = Object.keys(executionResult.images);

  // Cap results at 30K chars — these are small scalar aggregations the LLM
  // needs verbatim for StatCard values and TextBlock content.
  const resultsJson = JSON.stringify(executionResult.results);
  const compactResults =
    resultsJson.length > 30_000
      ? truncateValue(executionResult.results, 30_000)
      : executionResult.results;

  const resultsSection =
    schemaMode === "metadata"
      ? `## Analysis Results Schema
${JSON.stringify(describeResultsSchema(compactResults as Record<string, unknown>))}

Use "$result:<key>" placeholders for all scalar values in StatCard, TrendIndicator, and similar components. Example: {"value": "$result:total_sales"}. Supports dot-notation for nested keys: "$result:summary.avg_price".`
      : `## Analysis Results
${JSON.stringify(compactResults)}`;

  const chartDataShape = Object.fromEntries(
    Object.entries(executionResult.chart_data).map(([k, v]) => [
      k,
      describeShape(v, schemaMode === "sample"),
    ])
  );

  return `## Original Question
${question}

${resultsSection}

## Chart Data Shapes
Available keys and their shapes:
${JSON.stringify(chartDataShape, null, 2)}
${
  useDataController
    ? `
Use "$chartData:<key>" placeholders ONLY when pre-populating initial /computed/* state values so charts have data on first render. Charts themselves MUST use {"$state": "/computed/<name>"} for their data prop — never "$chartData:" in component props directly.`
    : `
When referencing chart data in component props, use the string "$chartData:<key>" as the data value. It will be replaced with the actual array at render time. For example: "data": "$chartData:bar_data"
For HeatMap z/x_labels/y_labels, use "$chartData:heatmap.z", "$chartData:heatmap.x_labels", etc.
For Globe3D: use "$chartData:points" for the points prop and "$chartData:arcs" for the arcs prop. The Python code should output chart_data["points"] and chart_data["arcs"] as top-level keys.
For Surface3D: use "$chartData:<key>.z", "$chartData:<key>.x_labels", "$chartData:<key>.y_labels".`
}

${imageKeys.length > 0 ? `## Available Images\nThe following image keys are available for ChartImage components. Use the EXACT placeholder string as the src value:\n${imageKeys.map((k) => `- Use src: "IMAGE_PLACEHOLDER_${k}" for ${k}`).join("\n")}` : ""}`;
}

/** Dataset metadata for DataController awareness ("" when not applicable). */
function buildDatasetSection(analysis: DatasetAnalysis, schemaMode: SchemaMode): string {
  const { useDataController, mainDataset, datasetColumns, filterableColumns } = analysis;
  if (!useDataController || !mainDataset) return "";
  return `

## Dataset Available for Client-Side Filtering
A dataset with ${mainDataset.length} rows is available at state path /datasets/main.
Columns: ${datasetColumns.map((c) => `${c.name} (${c.distinct} distinct)`).join(", ")}
Filterable columns (categorical, <15 values): ${schemaMode === "metadata" ? filterableColumns.map((c) => `${c.name} (${c.distinct} distinct)`).join(", ") : filterableColumns.map((c) => `${c.name} [${c.sample.join(", ")}]`).join("; ")}

Use a DataController component to enable instant client-side filtering. The full dataset is stored at /datasets/main in spec.state. Structured chart_data (geojson, globe, sankey, etc.) is also auto-injected at /datasets/<key>. Charts MUST read from /computed/* state paths using {"$state": "/computed/<name>"} for their data prop — NOT "$chartData:" placeholders.`;
}

/** Drill-down framing with an AND-joined filter clause ("" when not a drill). */
function buildDrillDownSection(drillDownContext: DrillDownContext | null | undefined): string {
  if (!drillDownContext) return "";
  const extraFilters = drillDownContext.additional_filters ?? [];
  // Multi-select values become "col is one of [...]" / "col IN (...)".
  const fmtLine = (col: string, v: FilterValue) =>
    Array.isArray(v) ? `- Filter: ${col} is one of [${v.join(", ")}]` : `- Filter: ${col} = ${v}`;
  const fmtClause = (col: string, v: FilterValue) =>
    Array.isArray(v) ? `${col} IN (${v.map((x) => `"${x}"`).join(", ")})` : `${col} = "${v}"`;
  const filterLines = [
    fmtLine(drillDownContext.filter_column, drillDownContext.filter_value),
    ...extraFilters.map((f) => fmtLine(f.column, f.value)),
  ].join("\n");
  const filterClause = [
    fmtClause(drillDownContext.filter_column, drillDownContext.filter_value),
    ...extraFilters.map((f) => fmtClause(f.column, f.value)),
  ].join(" AND ");
  return `

## Drill-Down Context
This is a drill-down analysis. The user clicked on a chart segment to explore deeper.
- Parent question: ${drillDownContext.parent_question}
- Segment clicked: "${drillDownContext.segment_label}"
${filterLines}
${drillDownContext.chart_title ? `- Source chart: ${drillDownContext.chart_title}` : ""}

Focus the analysis specifically on data where ${filterClause}. Provide detailed breakdown and insights for this specific segment.`;
}

/**
 * Conversation history for follow-ups (from server-side cache). BUT:
 * re-asking the SAME question is a style/re-render request, not a follow-up —
 * including the "build on / maintain continuity" anchor there makes the model
 * replicate the previous dashboard's structure and ignore the newly selected
 * style. So we only attach continuity context for a genuinely NEW question,
 * and even then we tell it the requested style governs the form.
 */
function buildHistorySection(priorTurns: ConversationTurn[], question: string): string {
  const isRestyle =
    priorTurns.length > 0 &&
    priorTurns[priorTurns.length - 1].question.trim().toLowerCase() ===
      question.trim().toLowerCase();
  if (priorTurns.length === 0 || isRestyle) return "";
  return `

## Conversation History
The user is asking a follow-up question. Previous turns in this conversation:
${priorTurns.map((turn, i) => `### Turn ${i + 1}: "${turn.question}"\nDashboard showed:\n${turn.specSummary}`).join("\n\n")}

Build on the prior analysis where relevant, but compose THIS response in the requested output style/form (see the style rules) — do not simply replicate the previous dashboard's structure.`;
}

/** Multi-sheet workbook context ("" when not an Excel workbook analysis). */
function buildWorkbookSection(workbookContext: string | null | undefined): string {
  if (!workbookContext) return "";
  return `

## Workbook Context
This analysis was performed across multiple sheets in an Excel workbook. The code joined/merged data from different sheets.
${workbookContext}`;
}

const CLOSING_INSTRUCTION = `

Compose the output that answers the user's question, following the OUTPUT STYLE described in the rules above — that style governs the form (layout, density, framing). Let the question and data decide which visualizations and how many.`;

// ── Rules builders ───────────────────────────────────────────────────

/** Domain-aware UI rules keyed off the schema's detected domain. */
function domainUiRules(detectedDomain: CSVSchema["detected_domain"]): string[] {
  if (detectedDomain === "financial") {
    return [
      'For financial metrics, use StatCard with format="currency" and precision=2. For percentage changes, use format="percent".',
      "Use CandlestickChart for OHLC price data — prefer it over LineChart when open/high/low/close are available.",
      "Use WaterfallChart for P&L bridges, revenue walks, or cumulative change breakdowns.",
      "For period-over-period comparisons, use TrendIndicator with format and precision props.",
      "Negative financial values (losses, declines) should display naturally — do not hide the sign.",
    ];
  }
  if (detectedDomain === "statistical") {
    return [
      "For statistical test results, use Annotation (severity: info) to display test names, p-values, and effect sizes clearly.",
      "Use BoxPlot or ViolinChart for distribution comparisons — prefer these over bar charts for numeric distributions.",
      "Use HeatMap with show_values: true for correlation matrices.",
      "When showing regression results, use ScatterChart with show_regression: true.",
    ];
  }
  if (detectedDomain === "time_series") {
    return [
      "Use LineChart for time-series trends. Use show_dots: false for dense daily data, show_dots: true for sparse monthly/quarterly data.",
      "For period comparisons (YoY, MoM), use TrendIndicator or DumbbellChart.",
      "Use CalendarChart for daily metrics that benefit from a calendar view.",
    ];
  }
  return [];
}

/**
 * The full compose rules list: domain rules, metadata-mode placeholder
 * discipline, the chart-type catalog, and the DataController wiring contract
 * (or the static $chartData contract when no controller is warranted).
 */
function buildComposeRules(args: {
  schema: CSVSchema;
  schemaMode: SchemaMode;
  purpose: string;
  useDataController: boolean;
  sampleNote: string | null;
}): string[] {
  const { schema, schemaMode, purpose, useDataController, sampleNote } = args;
  return [
    ...domainUiRules(schema.detected_domain),
    ...(schemaMode === "metadata"
      ? [
          'Use "$result:<key>" placeholders for ALL scalar values in StatCard value, TrendIndicator value/previous, and any other numeric display props. Never fabricate or guess specific numbers.',
          "TextBlock content must be qualitative and descriptive — do NOT include specific numeric values. Describe trends, patterns, and relationships without citing exact figures.",
          "Never hallucinate specific numeric values. If you need a number displayed, it MUST come from a $result:<key> placeholder.",
        ]
      : []),
    "Do NOT fabricate large data arrays (e.g. GeoJSON boundaries, coordinate tables) that are not in the chart_data or results. Small scalar values from results (for StatCard, TextBlock, etc.) are fine to inline.",
    getPurposePrompt(purpose),
    "Use StatCard for key metrics. Group them in a LayoutGrid (columns: 2-4).",
    "Use the appropriate chart type for the data shape.",
    "Add Annotation components for outliers, notable patterns, or caveats.",
    "If results includes an `analysis_scope` value, it is the analyst's OWN provenance note describing exactly what was covered and how — it may state FULL coverage (e.g. 'Analyzed all 13,679,957 buildings ... via an exact KD-tree') OR a bounded/sampled subset. Surface it near the TOP as an Annotation (severity: info) titled 'Analysis Scope', using its text VERBATIM. Do NOT paraphrase it, and do NOT assume it means the data was sampled or bounded — quote what it actually says. Only frame it as a caveat (warning severity) when the text itself describes a bound, sample, or approximation.",
    "Use TrendIndicator when comparing two time periods.",
    "Use ChartImage ONLY when images were generated in the sandbox (truly custom matplotlib visualizations).",
    "For distribution analysis, use Histogram (pass raw data rows + value_key, optional group_key for overlaid groups).",
    "For comparing distributions across groups, use BoxPlot (raw data rows + value_key + group_key) or ViolinChart (same props, shows density shape).",
    useDataController
      ? 'For correlation matrices or 2D numeric grids, use HeatMap (z, x_labels, y_labels, show_values: true). If the heatmap is a crosstab/pivot of the main dataset, use a DataController output with pipeline: [{op: "pivot", rowKey, columnKey, valueKey, aggFn}] and format: "matrix". HeatMap reads z: {"$state": "/computed/heatmap/z"}, x_labels: {"$state": "/computed/heatmap/x_labels"}, y_labels: {"$state": "/computed/heatmap/y_labels"}. For custom-computed matrices (e.g. correlation), use "$chartData:" directly. Do NOT use ChartImage for correlation matrices.'
      : "For correlation matrices or 2D numeric grids, use HeatMap (z: number[][], x_labels, y_labels, show_values: true). Do NOT use ChartImage for correlation matrices.",
    "For ML confusion matrices, use ConfusionMatrix (matrix: number[][], labels: string[]). Set normalize: true for percentages. Do NOT use HeatMap or ChartImage for confusion matrices.",
    "For ROC or Precision-Recall curves, use RocCurve (curves: [{label, fpr, tpr, auc?}], curve_type: 'roc'|'pr'). Supports multiple curves for model comparison. Do NOT use matplotlib/ChartImage.",
    "For SHAP feature importance, use ShapBeeswarm (data: [{feature, shap_value, feature_value}]). x = SHAP value, y = feature, color = feature value. Do NOT use ChartImage.",
    useDataController
      ? 'For flow/transfer/journey visualizations, use SankeyChart (nodes: [{id}], links: [{source, target, value}]). Include filter columns as extra properties on node objects. Add a DataController output: {statePath: "/computed/sankey", format: "sankeyData", sourceStatePath: "/datasets/sankey"}. SankeyChart reads nodes: {"$state": "/computed/sankey/nodes"}, links: {"$state": "/computed/sankey/links"}. Pre-populate /computed/sankey in initial state with "$chartData:sankey".'
      : "For flow/transfer/journey visualizations, use SankeyChart (nodes: [{id}], links: [{source, target, value}]). Use for budget flows, user journeys, energy transfers, funnel analysis.",
    "For hierarchical part-to-whole data, use TreemapChart (recursive tree: {name, value?, children?}). For radial hierarchy, use SunburstChart (same data shape). Do NOT use ChartImage.",
    "For radar/spider multi-metric comparison, use RadarChart (data rows, index_key for axes, keys for series). Use for scorecards, profile comparison.",
    "For ranking changes over time, use BumpChart (data: [{id, data: [{x, y}]}] where y = rank).",
    useDataController
      ? 'For inter-group relationships/flows, use ChordChart (matrix, keys). If the chord matrix is a crosstab/pivot of the main dataset, use a DataController output with pipeline: [{op: "pivot", rowKey, columnKey, valueKey, aggFn}] and format: "chordMatrix". ChordChart reads matrix: {"$state": "/computed/chord/matrix"}, keys: {"$state": "/computed/chord/keys"}. For custom-computed matrices, use "$chartData:" directly.'
      : "For inter-group relationships/flows, use ChordChart (matrix: number[][], keys: string[]). matrix[i][j] = flow from i to j.",
    "For GitHub-style calendar heatmaps of daily values, use CalendarChart (data: [{day, value}], from, to).",
    "For stacked stream/ThemeRiver time series, use StreamChart (data rows, keys for categories).",
    "For cumulative positive/negative effects (P&L, bridge charts), use WaterfallChart (data: [{label, value, type}]). type: 'absolute' for start, 'relative' for change, 'total' for subtotal.",
    "For comparing distributions across groups as overlapping density curves, use RidgelineChart (data rows, value_key, group_key).",
    "For before/after or paired comparisons, use DumbbellChart (data: [{label, start, end}]). For two-period ranking shifts, use SlopeChart (same data shape).",
    "For showing individual data points with jitter, use BeeswarmChart (data rows, value_key, group_key).",
    "For variable-width stacked bars (two-dimensional composition), use MarimekkoChart (data rows, id_key, value_key, dimensions).",
    "For multivariate exploration across many dimensions, use ParallelCoordinates (data rows, dimensions: string[], group_key for coloring).",
    "For progress against targets with qualitative ranges, use BulletChart (data: [{label, value, target?, ranges}]). Use for KPI dashboards.",
    "For ML decision trees or decision flowcharts, use DecisionTree (recursive tree: {label, value?, condition?, children?}). Do NOT use ChartImage.",
    'Always include a final TextBlock (variant: "body") that explains the methodology in plain, non-technical English. Describe: how many rows were analyzed, which columns were used for grouping or aggregation, what operations were performed (totals, averages, counts, etc.), and any rows excluded due to missing data. Use simple language — no code references, no terms like DataFrame or groupby. Example: "This analysis looked at 12,847 sales records. Revenue was totaled by quarter using the close_date column. 3 records with missing values were excluded. The growth rate was calculated by comparing each quarter to the same quarter in the prior year."',
    "Keep total component count under 20.",
    "Wrap everything in a LayoutColumn as the root element.",
    "Output ONLY raw JSONL lines. Do NOT wrap in markdown code fences.",
    ...(useDataController
      ? [
          "CRITICAL: Use exactly ONE DataController as a top-level wrapper around ALL dashboard content (StatCards, charts, tables, annotations). Do NOT create multiple DataControllers — one per chart or per section. A single DataController renders one set of filter dropdowns that control the entire dashboard.",
          "The ONE DataController must define ALL filters, ALL pipeline steps, and ALL outputs needed by every chart and stat card in the dashboard. Each chart gets its own output path (e.g. /computed/bar_data, /computed/line_data, /computed/stats) but they all come from the same DataController pipeline.",
          "Exception: If a filter semantically applies to only ONE specific chart or section and not the rest of the dashboard, you may use a nested DataController for just that section. This is rare — most filters apply dashboard-wide.",
          'Charts inside the DataController MUST use {"$state": "/computed/<name>"} for their data prop. Do NOT use "$chartData:" placeholders in chart component data props — only in initial /computed/* state values.',
          'DataController props: source: {statePath: "/datasets/main"}, filters: [{key, column, bindTo: "/filters/<col>", label, allowAll: true, dependsOn: null}], pipeline: [{op: "filter"}, ...shared steps...], outputs: [{statePath: "/computed/<name>", format: null, pipeline: [...per-output steps...]}].',
          'The top-level "pipeline" runs shared steps (typically just [{op: "filter"}]). Each output can define its OWN "pipeline" array inside the output object — these steps run on the filtered data independently. This lets one DataController produce different aggregations for different charts. Example: outputs: [{statePath: "/computed/by_region", pipeline: [{op: "groupBy", columns: ["region"], aggregations: [{column: "sales", fn: "sum", as: "total"}]}], format: null}, {statePath: "/computed/by_category", pipeline: [{op: "groupBy", columns: ["category"], aggregations: [{column: "sales", fn: "sum", as: "total"}]}], format: null}]. Outputs WITHOUT a pipeline field use the shared pipeline result.',
          'Pipeline ops: "filter" (reads active filter state), "groupBy" (columns + aggregations with fn: sum/avg/min/max/count/countDistinct/median), "sort" (column + direction), "limit" (count), "topN" (column + n + direction), "pivot" (rowKey + columnKey + valueKey + aggFn), "compute" (column + expression like "percent(a,b)").',
          'Set initial state: datasets.main is injected automatically. Set /filters/<col> initial values (e.g. "All"). Pre-populate /computed/* paths using "$chartData:<key>" placeholders (e.g. "$chartData:bar_data") so charts render before any filter interaction — these placeholders are replaced with real data at stream time.',
          'StatCards MUST also update when filters change. Add a pipeline output with format: "stats" that uses groupBy with empty columns [] and aggregations (sum, count, avg, etc.) to compute summary values, and outputs to a stats path (e.g. "/computed/stats"). The "stats" format extracts the first row as a flat {key: value} object. Then set each StatCard value to {"$state": "/computed/stats/<field_name>"}. Numbers are auto-formatted (e.g. 1234567 → "1.2M"). Pre-populate /computed/stats in initial state with "$chartData:<stats_key>" so StatCards render before filter interaction.',
          'Additional output formats for structured charts — Pattern A (filter structured data in state): format "geojson" with sourceStatePath filters GeoJSON FeatureCollection features by properties. format "globeData" with sourceStatePath filters points[] by properties, keeps arcs[] only where both endpoints survive. format "sankeyData" with sourceStatePath filters nodes[] by properties, keeps links[] only where both source and target survive. All three require sourceStatePath pointing to the unfiltered data in /datasets/<key>.',
          'Additional output formats — Pattern B (derive from pivoted rows): format "matrix" converts pivot output rows to {z: number[][], x_labels: string[], y_labels: string[]} for HeatMap/Surface3D. format "chordMatrix" converts pivot output rows to {matrix: number[][], keys: string[]} for ChordChart. Both require a pivot step in the output pipeline.',
          "Do NOT use SelectControl/NumberInput/ToggleSwitch for filtering when DataController is present — the DataController renders its own filter dropdowns.",
          'Charts can enable click-to-filter cross-filtering via the "selects" prop. Set selects: {column: "<column>", bindTo: "/filters/<column>"} where bindTo matches a DataController filter. Clicking a bar or pie slice filters the dashboard; clicking again deselects.',
          "Use selects on BarChart and PieChart when the axis or slice represents a filterable category. Do NOT use selects AND on.click drillDown on the same chart.",
          "Cross-filtering is best with 2-3 charts selecting into different filter dimensions.",
          'CRITICAL: EVERY /computed/<key> that ANY component reads MUST be produced by a DataController output (an entry in `outputs` with that statePath) or pre-populated via "$chartData:". A component bound to a /computed/<key> that no output produces renders EMPTY (blank table, empty map). Never invent a computed key you did not add to `outputs`.',
          "REUSE computed keys: if a table and a chart show the SAME rows (e.g. the top-N most X), point BOTH at ONE /computed/<key>. Do NOT declare a second, separate key for the table or map — that second key ends up unproduced and empty.",
          'DataTable inside the DataController: bind `rows` to {"$state": "/computed/<key>"} where <key> is produced by a DataController output that yields a RECORDS array (e.g. a sort+limit for a top-N table). Its `columns` MUST be {key, label} objects whose "key" EXACTLY matches the record field names — e.g. rows of {short_id, nn_distance_m} → columns [{"key":"short_id","label":"Building"},{"key":"nn_distance_m","label":"NN Distance (m)"}]. Plain-string column headers do NOT match record fields and every cell renders blank.',
          'CORRECTNESS: /datasets/main is often a truncated/sampled subset of the full data (capped at 5000 rows), so re-deriving a "top N / most / farthest / largest" ranking from it via a DataController output can DISAGREE with the headline StatCards/annotations (which are computed in Python over the FULL data). For any ranking/extreme table OR a MapView of points, bind DIRECTLY to the PRE-COMPUTED data the analysis emitted (available at /datasets/<chart_data_key>, e.g. rows: {"$state": "/datasets/top_20_isolated"}, markers: {"$state": "/datasets/buildings_map"}) — do NOT re-rank /datasets/main. That data is the server-computed truth and matches the headline. Use DataController /computed outputs only for aggregations that must react to the filters.',
        ]
      : [
          'Reference chart data using "$chartData:<key>" placeholders in data props. Do NOT inline data arrays. Example: "data": "$chartData:bar_data". For nested fields like heatmap data, use "$chartData:heatmap.z", "$chartData:heatmap.x_labels", "$chartData:heatmap.y_labels".',
          'For DataTable columns, use plain strings like ["Name", "Age"], NOT objects.',
          'For DataTable rows, use INLINED arrays of strings like [["Alice", "30"]] — NOT objects, and NOT a "$state" reference.',
        ]),
    ...(sampleNote
      ? [
          "CORRECTNESS — the interactive dataset (/datasets/main) is a SAMPLE of a larger result. Client-side re-aggregation of it is APPROXIMATE. Therefore: headline StatCards and the summary annotation MUST use exact $result:<key> values computed in Python over the FULL data — do NOT bind them to /computed/stats (which recomputes over the sample). Use /computed outputs only for charts that need to react to the filters. (A sample caveat is added to the dashboard automatically.)",
        ]
      : []),
    "When data supports further segmentation or breakdown, add on.click bindings with the drillDown action on chart components. Set appropriate params: segment_label (human-readable label for the segment), segment_value (the data value), chart_title (title of the chart), x_key/y_key (the data keys), filter_column (column to filter on), filter_value (value to filter by). Only add drill-down when further breakdown makes sense.",
    "Prefer named colors (indigo, emerald, amber, rose, violet, cyan, orange, pink) in color_map and colors props for consistent theming.",
    schema.has_geojson &&
    (schema.geojson_geometry_type === "Polygon" || schema.geojson_geometry_type === "MultiPolygon")
      ? useDataController
        ? 'This data has Polygon/MultiPolygon GeoJSON geometry. GeoJSON is auto-injected at /datasets/geojson. Add a DataController output: {statePath: "/computed/geojson", format: "geojson", sourceStatePath: "/datasets/geojson"}. MapView uses geojson: {"$state": "/computed/geojson"}. Pre-populate /computed/geojson in initial state with "$chartData:geojson". Use color_key for choropleth coloring, with color_scale: [low_color, high_color]. Do NOT pass markers when geojson polygons are available.'
        : 'This data has Polygon/MultiPolygon GeoJSON geometry. Use MapView with the geojson prop to render polygon boundaries — do NOT use markers for polygon data. Set geojson: "$chartData:geojson" and use color_key for choropleth coloring by a numeric property, with color_scale: [low_color, high_color]. Example: {"geojson": "$chartData:geojson", "color_key": "population_density", "color_scale": ["#f7fbff", "#08306b"]}. Do NOT pass markers when geojson polygons are available.'
      : 'Use MapView when data contains geographic coordinates (lat/lng). Pass markers as [{lat, lng, label, color}]. Only pass geojson if GeoJSON geometry is present in the chart_data — do NOT fabricate or inline GeoJSON. For choropleth maps (polygons colored by a numeric property), set color_key to the property name and optionally color_scale to [low_color, high_color]. Example: {"geojson": "$chartData:geojson", "color_key": "population", "color_scale": ["#f7fbff", "#08306b"]}.',
    useDataController
      ? 'Use Globe3D when data spans multiple countries or continents — flight routes, trade flows, global metrics. Include filter columns as extra properties on each point object (e.g. {lat, lng, label, region: row["region"]}). Add a DataController output: {statePath: "/computed/globe", format: "globeData", sourceStatePath: "/datasets/globe"}. Globe3D reads points: {"$state": "/computed/globe/points"}, arcs: {"$state": "/computed/globe/arcs"}. Pre-populate /computed/globe in initial state with "$chartData:globe". globe_style: "default" (blue marble), "night" (dark), "minimal" (topology).'
      : 'Use Globe3D when data spans multiple countries or continents — flight routes, trade flows, global metrics. Wire props using $chartData placeholders: "points": "$chartData:points", "arcs": "$chartData:arcs". The Python code should output chart_data["points"] and/or chart_data["arcs"] as top-level keys. Do NOT pass polygons unless the user explicitly asks for country boundary overlays — points and arcs are sufficient for most use cases. globe_style: "default" (blue marble), "night" (dark), "minimal" (topology).',
    "PREFER Map3D over MapView for point maps with more than ~50 points — it renders on a vibrant dark basemap with GPU-drawn points and reads far better. layer_type: 'scatterplot' for individual points (set value_key to a numeric metric to shade them along a color ramp — e.g. value_key: \"nn_dist_m\"), 'hexagon' or 'heatmap' for dense clusters/density, 'column' for extruded bars, 'arc' for origin-destination flows. Set lat_key/lng_key to the ACTUAL field names — DuckDB spatial emits `lon` (ST_X) and `lat` (ST_Y), so use lng_key: \"lon\", lat_key: \"lat\" when those are the fields. For a flat top-down point map set pitch: 0; the basemap is a clean light theme by default (points carry the color). Reserve plain MapView for a handful of labeled markers or GeoJSON choropleths.",
    "Use Scatter3D when there are three numeric variables to explore in 3D. Supports group_key for coloring by category and size_key for a 4th dimension.",
    useDataController
      ? 'Use Surface3D for gridded 2D data that benefits from a 3D surface view (response surfaces, interpolated terrain). If the surface is a crosstab/pivot of the main dataset, use a DataController output with pipeline: [{op: "pivot", rowKey, columnKey, valueKey, aggFn}] and format: "matrix". Surface3D reads z: {"$state": "/computed/surface/z"}, x_labels: {"$state": "/computed/surface/x_labels"}, y_labels: {"$state": "/computed/surface/y_labels"}. For custom-computed surfaces (e.g. correlation), use "$chartData:" directly.'
      : "Use Surface3D for gridded 2D data that benefits from a 3D surface view (response surfaces, interpolated terrain). Similar to HeatMap but rendered as rotatable 3D surface.",
    "Prefer 2D charts (BarChart, LineChart, ScatterChart, etc.) when they communicate the data effectively. Only use 3D components when the third dimension adds real analytical value.",
    'For interactive scenario planners, what-if tools, or calculators where NumberInput changes should reactively update StatCard values, use DataController with source.fromState. This builds a reactive single-row dataset from scalar state paths. Example: {"type":"DataController","props":{"source":{"fromState":{"units":"/inputs/units","price":"/inputs/price","margin":"/inputs/margin"}},"filters":[],"pipeline":[{"op":"compute","column":"revenue","expression":"multiply(units, price)"},{"op":"compute","column":"profit","expression":"percentOf(revenue, margin)"}],"outputs":[{"statePath":"/computed/stats","format":"stats"}]}}. NumberInputs bind via $bindState to /inputs/* paths, StatCards read via {"$state":"/computed/stats/revenue"}. Set initial /inputs/* values in spec.state. Compute ops: multiply(a,b), add(a,b), subtract(a,b), percentOf(a,b)=a*b/100, percent(a,b)=a/b*100, ratio(a,b)=a/b, diff(a,b)=a-b.',
  ];
}

/**
 * Pure: build the compose `userPrompt` + `customRules` for a single-shot
 * dashboard, plus the dataset analysis the stream step consumes. No I/O —
 * a plain assembly of the section builders above.
 */
export function buildDashboardComposeRequest(
  executionResult: SandboxExecutionResult,
  opts: DashboardComposeOpts
): DashboardComposeRequest {
  const { question, schema, schemaMode, purpose, priorTurns, drillDownContext, workbookContext } =
    opts;

  const analysis = analyzeDatasets(executionResult);

  const userPrompt =
    buildCorePrompt(executionResult, question, schemaMode, analysis.useDataController) +
    buildDatasetSection(analysis, schemaMode) +
    buildDrillDownSection(drillDownContext) +
    buildHistorySection(priorTurns, question) +
    buildWorkbookSection(workbookContext) +
    CLOSING_INSTRUCTION;

  const customRules = buildComposeRules({
    schema,
    schemaMode,
    purpose,
    useDataController: analysis.useDataController,
    sampleNote: analysis.sampleNote,
  });

  return {
    userPrompt,
    customRules,
    analysis: {
      useDataController: analysis.useDataController,
      mainDataset: analysis.mainDataset,
      imagePlaceholders: analysis.imagePlaceholders,
      sampleNote: analysis.sampleNote,
    },
  };
}

/**
 * Compose a single-shot dashboard from an execution result and stream the
 * finalized spec patches to `emit`. Used by the Ask route and the Investigate
 * lookup fast-path. `isClosed()` lets the caller abort mid-stream.
 */
export async function composeAndStreamDashboard(args: {
  executionResult: SandboxExecutionResult;
  opts: DashboardComposeOpts;
  uiComposeModel: string;
  emit: (data: string) => void;
  isClosed: () => boolean;
  /** Called just before the LLM stream begins (e.g. to emit a progress event). */
  onComposing?: () => void;
}): Promise<void> {
  const { executionResult, opts, uiComposeModel, emit, isClosed, onComposing } = args;
  const { userPrompt, customRules, analysis } = buildDashboardComposeRequest(executionResult, opts);
  const { useDataController, mainDataset, imagePlaceholders, sampleNote } = analysis;

  onComposing?.();

  const llmResult = streamText({
    model: getModel(uiComposeModel),
    system: cachedSystem(catalog.prompt({ customRules })),
    prompt: userPrompt,
    temperature: 0,
    maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
  });
  const textStream = llmResult.textStream;

  let buffer = "";
  let stateInjected = false;
  let lineCount = 0;
  // Accumulate finalized patches so we can audit computed-key producers once the
  // spec is fully composed (warn-only — see auditComputedKeys).
  const composedPatches: PatchLike[] = [];
  // Narrative prose accumulated across the stream, for the grounding pass below.
  const narrativeTexts: string[] = [];
  const emitPatch = (line: string) => {
    emit(line + "\n");
    try {
      collectNarrativeStrings((JSON.parse(line) as { value?: unknown }).value, 0, narrativeTexts);
    } catch {
      // non-JSON keepalive / partial — nothing to collect
    }
  };

  const validStateKeys: ValidStateKeys | null = useDataController
    ? {
        computed: new Set<string>([
          ...Object.keys(executionResult.chart_data ?? {}),
          ...Object.keys(executionResult.results ?? {}),
        ]),
        datasets: new Set<string>([...Object.keys(executionResult.chart_data ?? {}), "main"]),
      }
    : null;

  const finalize = createSpecFinalizer({
    results: executionResult.results,
    chartData: executionResult.chart_data,
    imagePlaceholders,
    validStateKeys,
    mutatePatch: (patch) => {
      if (
        useDataController &&
        !stateInjected &&
        mainDataset &&
        patch.op === "add" &&
        patch.path === "/state" &&
        patch.value &&
        typeof patch.value === "object"
      ) {
        const value = patch.value as Record<string, unknown>;
        const datasets = (value.datasets ??= {}) as Record<string, unknown>;
        datasets.main = mainDataset;
        for (const [key, v] of Object.entries(executionResult.chart_data)) {
          if (v && typeof v === "object") datasets[key] = v;
        }
        stateInjected = true;
        return true;
      }
      // Deterministically stamp the sample caveat onto the DataController element,
      // regardless of what the LLM emitted, so the user is always warned when the
      // interactive data is a sample.
      if (
        sampleNote &&
        patch.op === "add" &&
        typeof patch.path === "string" &&
        patch.path.startsWith("/elements/") &&
        patch.value &&
        typeof patch.value === "object" &&
        (patch.value as { type?: unknown }).type === "DataController"
      ) {
        const el = patch.value as { props?: Record<string, unknown> };
        el.props = el.props ?? {};
        if (!el.props.sample_note) {
          el.props.sample_note = sampleNote;
          return true;
        }
      }
      return false;
    },
  });

  const processLine = (line: string): string | null => {
    const result = finalize(line);
    if (result.skip) return null;
    lineCount++;
    if (result.patch) composedPatches.push(result.patch as PatchLike);
    return result.line;
  };

  try {
    // NOTE: we do NOT stop on isClosed() — the compose runs to completion even if
    // the client disconnected, so the FULL patch stream is produced. emit() no-ops
    // to the dead socket, but the route accumulates the patches to assemble + save
    // the spec (a mid-run disconnect must not waste the analysis).
    for await (const chunk of textStream) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const result = processLine(line.trim());
        if (result !== null) emitPatch(result);
      }
    }
    if (buffer.trim()) {
      const result = processLine(buffer.trim());
      if (result !== null) emitPatch(result);
    }

    // Warn-only: flag components that read a /computed/<key> nothing produces —
    // they render empty (blank table/map). Tracked in logs, spec left untouched.
    const audit = auditComputedKeys(composedPatches);
    if (audit.unproduced.length > 0) {
      logger.warn("Composed spec reads unproduced computed keys (will render empty)", {
        unproduced: audit.unproduced,
        produced: audit.produced,
      });
    }
  } catch (streamErr) {
    if (!isClosed()) {
      logger.error("Stream error", {
        error: streamErr instanceof Error ? streamErr.message : String(streamErr),
      });
      if (lineCount === 0) {
        const errMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
        emit(JSON.stringify({ op: "add", path: "/root", value: "error" }) + "\n");
        emit(
          JSON.stringify({
            op: "add",
            path: "/elements/error",
            value: {
              type: "Annotation",
              props: {
                icon: "alert",
                title: "Analysis Error",
                content: errMsg.includes("too long")
                  ? "The analysis data is too large for the AI to process. Try a more specific question."
                  : errMsg,
                severity: "error",
              },
              children: [],
            },
          }) + "\n"
        );
      }
    }
  }

  // If the LLM streamed state as individual field patches (not a single /state
  // add), we still need to inject the dataset (also when closed, so the assembled
  // spec is complete for history).
  if (useDataController && !stateInjected && mainDataset) {
    const datasetsPayload: Record<string, unknown> = { main: mainDataset };
    for (const [key, value] of Object.entries(executionResult.chart_data)) {
      if (typeof value === "object" && value !== null) datasetsPayload[key] = value;
    }
    emit(JSON.stringify({ op: "add", path: "/state/datasets", value: datasetsPayload }) + "\n");
  }

  // Grounding (SHARED with Investigate): flag any narrative figure that traces
  // to no computed value, so the same "verify these figures" caveat fires for a
  // single-shot dashboard too. Best-effort; only surfaced when there's an actual
  // ungrounded figure (no steps to cite in single-shot, so silence when clean).
  if (!isClosed()) {
    try {
      const grounded = collectGroundedValues(
        (executionResult.results ?? {}) as Record<string, unknown>,
        (executionResult.chart_data ?? {}) as Record<string, unknown>
      );
      const datasets = executionResult.datasets as Record<string, unknown> | undefined;
      if (datasets) grounded.push(...collectGroundedValues({}, datasets));
      const report = verifyGrounding({
        narrativeTexts,
        citedSteps: [],
        grounded,
        successfulStepNos: [],
      });
      if (!report.ok) {
        emit(JSON.stringify({ op: "add", path: "/state/__grounding", value: report }) + "\n");
      }
    } catch (err) {
      logger.debug("compose grounding failed (best-effort)", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
