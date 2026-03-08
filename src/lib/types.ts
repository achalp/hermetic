// ── Column metadata (discriminated union) ──────────────────────────

export interface NumericMeta {
  kind: "number";
  is_integer: boolean;
  decimal_precision: number;
  is_currency: boolean;
  currency_symbol?: string;
  is_percentage: boolean;
  min: number;
  max: number;
  mean: number;
  median: number;
  std_dev: number;
  p25: number;
  p75: number;
  zero_count: number;
  negative_count: number;
  /** Asymmetry of distribution: >0 right-skewed, <0 left-skewed */
  skewness?: number;
  /** Tail heaviness: >3 heavy-tailed, <3 light-tailed (excess kurtosis) */
  kurtosis?: number;
  /** Count of values beyond 1.5×IQR fences */
  outlier_count?: number;
  /** Percentage of null/empty values (0-100) */
  null_pct?: number;
}

export interface DateMeta {
  kind: "date";
  format: string;
  min_date: string;
  max_date: string;
  uses_month_names: boolean;
  uses_day_names: boolean;
  has_time: boolean;
  granularity: "year" | "quarter" | "month" | "week" | "day" | "hour" | "minute" | "second";
}

export interface CategoricalMeta {
  kind: "categorical";
  distinct_count: number;
  distinct_values?: string[];
  top_values?: { value: string; count: number }[];
  avg_length: number;
  max_length: number;
  min_length: number;
  is_unique: boolean;
  detected_pattern?: string;
}

export interface BooleanMeta {
  kind: "boolean";
  true_count: number;
  false_count: number;
  representation: "true/false" | "0/1" | "yes/no" | "mixed";
}

export type ColumnMeta = NumericMeta | DateMeta | CategoricalMeta | BooleanMeta;

export type SchemaMode = "metadata" | "sample";

// ── Schema types ───────────────────────────────────────────────────

export interface CSVColumn {
  name: string;
  dtype: "string" | "number" | "date" | "boolean";
  null_count: number;
  meta: ColumnMeta;
  sample_values: string[];
}

export interface CSVSchema {
  csv_id: string;
  filename: string;
  row_count: number;
  columns: CSVColumn[];
  sample_rows: Record<string, string>[];
  /** true when the uploaded file was GeoJSON */
  has_geojson?: boolean;
  /** Dominant geometry type: "Point" | "Polygon" | "LineString" | etc. */
  geojson_geometry_type?: string;
  /** Detected data domain based on column patterns */
  detected_domain?: DataDomain;
  /** Top pairwise correlations between numeric columns */
  correlations?: ColumnCorrelation[];
}

/** Detected domain hints for prompt specialization */
export type DataDomain = "financial" | "time_series" | "statistical" | "general";

/** A pairwise correlation between two numeric columns */
export interface ColumnCorrelation {
  col_a: string;
  col_b: string;
  pearson: number;
}

// ── Execution types ────────────────────────────────────────────────

export interface SandboxExecutionResult {
  success: true;
  results: Record<string, unknown>;
  chart_data: Record<string, unknown>;
  images: Record<string, string>;
  datasets?: Record<string, Record<string, unknown>[]>;
  execution_ms: number;
}

export interface SandboxExecutionError {
  success: false;
  error: string;
  execution_ms: number;
}

export type ExecutionResult = SandboxExecutionResult | SandboxExecutionError;

export interface StoredCSV {
  schema: CSVSchema;
  filePath: string;
  createdAt: number;
}

export type PipelineStage =
  | "generating_code"
  | "executing"
  | "retrying"
  | "composing_ui"
  | "done"
  | "error";

export interface DrillDownParams {
  segment_label: string;
  segment_value: string | number;
  chart_title: string | null;
  x_key: string | null;
  y_key: string | null;
  filter_column: string;
  filter_value: string | number;
}

export interface ConversationEntry {
  question: string;
  specSummary: string;
}

export interface SavedVizMeta {
  vizId: string;
  question: string;
  csvFilename: string;
  createdAt: number;
}

// ── Excel types ─────────────────────────────────────────────────────

export interface SheetInfo {
  name: string;
  rowCount: number;
  columnCount: number;
  headers?: string[];
  sampleRows?: string[][];
}

// ── Cross-sheet relationship types ──────────────────────────────────

export type RelationshipMatchType = "exact_name" | "fuzzy_name" | "value_overlap";

export interface SheetRelationship {
  sourceSheet: string;
  sourceColumn: string;
  sourceColumnIndex: number;
  targetSheet: string;
  targetColumn: string;
  targetColumnIndex: number;
  matchType: RelationshipMatchType;
  confidence: number;
  isPrimaryKeyCandidate: boolean;
  isForeignKeyCandidate: boolean;
}

// ── Workbook (multi-sheet) types ────────────────────────────────────

export interface WorkbookManifest {
  sheets: { name: string; csvId: string; schema: CSVSchema }[];
  relationships: SheetRelationship[];
}
