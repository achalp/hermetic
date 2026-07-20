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
  /** Where the data came from */
  source_type?: "file" | "warehouse";
  /** Which warehouse type (only set when source_type === "warehouse") */
  warehouse_type?: WarehouseType;
  /** Fully qualified table name (only set when source_type === "warehouse") */
  warehouse_table?: string;
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
  /**
   * Structured failure class for the errors that drive CONTROL FLOW —
   * previously the orchestrator's no-retry decision string-matched
   * /timed out/ against docker-utils' message, with nothing tying the two
   * together (a reworded message would silently re-enable futile retries).
   * "timeout" → fail fast, don't retry; "oom" → retry with lean-script
   * guidance; "stopped" → the user cancelled — fail fast, don't retry.
   * Absent for ordinary execution errors.
   */
  errorKind?: "timeout" | "oom" | "stopped";
  execution_ms: number;
  /**
   * Post-mortem diagnostics captured at failure — the container's self-reported
   * DuckDB config line (HERMETIC_DUCKDB_CFG: threads=…), the OOM phase, and a
   * stderr tail. Saved as attempt-NN.diag.txt so a hard-kill OOM (where the
   * container is torn down before the console can surface it) is still
   * diagnosable from the run recorder.
   */
  execDiag?: string;
}

export type ExecutionResult = SandboxExecutionResult | SandboxExecutionError;

/** Optional cloud credentials for a private remote Parquet bucket. Anonymous
 *  access (public buckets like Overture) needs none of this. */
export interface RemoteCreds {
  s3Region?: string;
  s3AccessKeyId?: string;
  s3SecretAccessKey?: string;
  s3Endpoint?: string;
}

export interface StoredCSV {
  schema: CSVSchema;
  filePath: string;
  createdAt: number;
  /** Last time this entry was read. Expiry is a SLIDING idle window measured
   *  from here (not from createdAt), so an actively-used dataset never expires
   *  mid-session. Defaults to createdAt. */
  lastAccessedAt?: number;
  /** The runId that last read this entry. While that run is still in-flight the
   *  entry is pinned (never swept), so a legitimately long analysis can't lose
   *  its own data — the sandbox exec touches the store only at its start. */
  ownerRunId?: string;
  /** For local files: host filesystem path (not copied into temp) */
  localPath?: string;
  /** For local Parquet folders: host directory path */
  localFolderPath?: string;
  /** mtime at schema extraction time, for cache invalidation */
  localMtime?: number;
  /** Whether this is a Parquet file/folder */
  isParquet?: boolean;
  /** Whether this is a Hive-partitioned Parquet dataset */
  isHivePartitioned?: boolean;
  /** For a REMOTE cloud Parquet source: the s3:// or https:// URL DuckDB reads
   *  directly (no download, no bind-mount). */
  remoteParquetUrl?: string;
  /** Optional cloud credentials for a private remote bucket (anon when unset). */
  remoteCreds?: RemoteCreds;
}

export type PipelineStage =
  | "generating_code"
  | "reviewing_code"
  | "revising_code"
  | "executing"
  | "retrying"
  | "composing_ui"
  | "done"
  | "error";

/**
 * A drill filter value. A single category (string/number) pins one segment; an
 * array pins a multi-select (the server filters `column IN (...)`).
 */
export type FilterValue = string | number | (string | number)[];

export interface DrillDownParams {
  segment_label: string;
  segment_value: string | number;
  chart_title: string | null;
  x_key: string | null;
  y_key: string | null;
  filter_column: string;
  filter_value: FilterValue;
  /**
   * Additional filters AND-combined with the primary filter. Used by 2D
   * drill-downs (e.g. PivotTable cell = rowDim × colDim) and multi-dimension
   * selections where a single filter isn't enough to pin the segment.
   */
  additional_filters?: { column: string; value: FilterValue }[] | null;
}

export interface ConversationEntry {
  question: string;
  specSummary: string;
}

/** Structured record of a single analysis turn for follow-up context */
export interface ConversationTurn {
  question: string;
  /** What the code computed — compact shapes, not raw data */
  analysisSummary: {
    /** result keys with their JS types: {total_revenue: "number", top_region: "string"} */
    resultKeys: Record<string, string>;
    /** For each chart_data key: column names and row count */
    chartDataShapes: Record<string, { columns: string[]; rows: number }>;
  };
  /** Compact text tree of the dashboard layout (from summarizeSpec) */
  specSummary: string;
}

// ── Analysis history types ─────────────────────────────────────

export interface HistoryMeta {
  id: string;
  question: string;
  timestamp: number;
  /**
   * The dataset id this run executed under (the materialized-result id for
   * warehouse runs). Lets the artifacts endpoint fall back to this persisted
   * entry when the in-memory artifacts cache (10-min TTL) has expired, instead
   * of showing a blank trail. Optional — absent on entries saved before this.
   */
  csvId?: string;
  sourceFile: string;
  sourceType: "upload" | "local" | "warehouse";
  localPath?: string;
  warehouseType?: WarehouseType;
  rowCount: number;
  columnCount: number;
  chartTypes: string[];
  executionMs: number;
  specSummary: string;
  description?: string;
}

export interface SavedVizMeta {
  vizId: string;
  question: string;
  csvFilename: string;
  createdAt: number;
  versionCount?: number;
  latestVersionTs?: number;
  schemaFingerprint?: string;
  /** How the data was originally sourced */
  sourceType?: "upload" | "local" | "warehouse";
  /** Host filesystem path for local file sources */
  localPath?: string;
  /** SQL query for warehouse sources (used during refresh) */
  sql?: string;
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

// ── Warehouse types ────────────────────────────────────────────────

export type WarehouseType =
  | "postgresql"
  | "bigquery"
  | "clickhouse"
  | "trino"
  | "hive"
  | "snowflake"
  | "databricks";

export interface PostgresConnectionConfig {
  type: "postgresql";
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
  schema?: string;
}

export interface BigQueryConnectionConfig {
  type: "bigquery";
  projectId: string;
  dataset: string;
  credentialsJson: string;
}

export interface ClickHouseConnectionConfig {
  type: "clickhouse";
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
}

export interface TrinoConnectionConfig {
  type: "trino";
  host: string;
  port: number;
  user: string;
  catalog: string;
  schema: string;
  password?: string;
  ssl?: boolean;
}

export interface HiveConnectionConfig {
  type: "hive";
  host: string;
  port: number;
  database: string;
  user: string;
  password?: string;
  auth?: "NONE" | "NOSASL" | "LDAP" | "KERBEROS";
}

export interface SnowflakeConnectionConfig {
  type: "snowflake";
  /** Account identifier, e.g. "abc12345.us-east-1" */
  account: string;
  user: string;
  password: string;
  database: string;
  schema?: string;
  warehouse?: string;
  role?: string;
}

export interface DatabricksConnectionConfig {
  type: "databricks";
  /** Server hostname, e.g. "abc-123.cloud.databricks.com" */
  serverHostname: string;
  /** HTTP path, e.g. "/sql/1.0/warehouses/abc123" */
  httpPath: string;
  /** Personal access token */
  token: string;
  /** Unity Catalog name */
  catalog: string;
  schema?: string;
}

export type WarehouseConnectionConfig =
  | PostgresConnectionConfig
  | BigQueryConnectionConfig
  | ClickHouseConnectionConfig
  | TrinoConnectionConfig
  | HiveConnectionConfig
  | SnowflakeConnectionConfig
  | DatabricksConnectionConfig;

export interface WarehouseTableInfo {
  schema: string;
  name: string;
  row_count_estimate: number;
  column_count: number;
}

/** Column metadata for warehouse schema introspection (lightweight, for SQL generation) */
export interface WarehouseColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  /** Optional human-readable description (sourced from dbt docs when linked) */
  description?: string;
}

/** Full schema of a single warehouse table (for SQL generation context) */
export interface WarehouseTableSchema {
  schema: string;
  name: string;
  columns: WarehouseColumnInfo[];
  row_count_estimate: number;
  primary_key?: string[];
  foreign_keys?: { column: string; references_table: string; references_column: string }[];
  /** Optional human-readable description (sourced from dbt docs when linked) */
  description?: string;
}

/**
 * The time range a warehouse investigation's data covers — derived from the
 * materialized pull's date column. Used to (a) keep escalated per-step SQL
 * within the same window and (b) label the dashboard so the reader knows the
 * analysis scope.
 */
export interface AnalysisWindow {
  /** The date/time column the window is measured on. */
  column: string;
  /** ISO-ish start (the column's min in the materialized data). */
  start: string;
  /** ISO-ish end (the column's max in the materialized data). */
  end: string;
}

export interface StoredWarehouse {
  warehouseId: string;
  config: WarehouseConnectionConfig;
  tables: WarehouseTableInfo[];
  /** Full column-level schemas for all tables — used for SQL generation */
  tableSchemas: WarehouseTableSchema[];
  createdAt: number;
  /** Sliding-idle-TTL bookkeeping (see lib/store-ttl.ts): last read + the run
   *  that pins this connection while it's in-flight. */
  lastAccessedAt?: number;
  ownerRunId?: string;
  /** Path to a dbt `manifest.json` whose docs enrich the LLM context */
  dbtManifestPath?: string;
}
