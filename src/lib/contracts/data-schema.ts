/**
 * Dataset & schema shapes shared by ingest, generation, and the UI.
 * Split from lib/types.ts (fan-in 85) — modularization M1-1a, spec S3.3.
 */

import type { WarehouseType } from "@/lib/contracts/connection-configs";

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

/**
 * A column the profiler deliberately did NOT read. Remote GEOMETRY/BLOB columns
 * are the case: their bytes ARE the cost of the scan (pulling the geometry
 * column pushed one Overture entity past a 60s budget), so they are described
 * and skipped.
 *
 * This is a real variant rather than a null `meta` for two reasons: every
 * consumer switches on `kind`, so a null is a landmine (it crashed the
 * suggestion heuristics and would have crashed every manifest prompt build);
 * and "unmeasured" must be SAYABLE. Fabricating a zeroed CategoricalMeta would
 * tell a planner this column has 0 distinct values, which is a measurement
 * nobody took.
 */
export interface UnprofiledMeta {
  kind: "unprofiled";
  /** Why it was skipped — surfaced verbatim to prompts and the rail. */
  reason: string;
}

export type ColumnMeta = NumericMeta | DateMeta | CategoricalMeta | BooleanMeta | UnprofiledMeta;

export type SchemaMode = "metadata" | "sample";

export interface CSVColumn {
  name: string;
  dtype: "string" | "number" | "date" | "boolean";
  null_count: number;
  meta: ColumnMeta;
  sample_values: string[];
}

/**
 * HOW a schema's statistics were obtained — provenance, so a consumer can tell a
 * whole-dataset fact from a slice of one.
 *
 * This matters because a remote Parquet profile reads a PREFIX (`LIMIT n` over
 * the leading row groups), not a random sample: reading a random sample over S3
 * would egress the entire dataset. A prefix is only a valid sample for a column
 * when the physical row order carries no information about it — and Overture is
 * sorted spatially, so the leading rows of a global buildings table are one
 * geographic patch. Ranges and distinct counts from such a prefix are not noisy
 * estimates of the dataset; they describe a different population, and the bias
 * does NOT shrink with depth (500k of 2.5B rows is 0.02% — a slightly bigger
 * patch of the same corner).
 *
 * So the honest fix is to spread the read and to say which it was, rather than to
 * buy more rows. `spread_sample` reads a slice from files spread ACROSS the
 * listing — the same bytes as a prefix, but spanning the dataset, so it is the
 * remote default; `leading_prefix` remains for a single-file source, where there
 * is nothing to spread across. Local sources get `random_sample` (DuckDB
 * `USING SAMPLE`, genuinely random, because the data is already here);
 * `full_scan` when the source fit inside the depth; `metadata` when nothing was
 * read at all (the describe tier).
 */
export interface ProfileBasis {
  kind: "metadata" | "full_scan" | "random_sample" | "spread_sample" | "leading_prefix";
  /** Rows the statistics were computed over (0 for `metadata`). */
  rows_examined: number;
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
  /** How the statistics below were obtained (absent on older cached schemas). */
  profile_basis?: ProfileBasis;
  /** Where the data came from */
  source_type?: "file" | "warehouse";
  /** Which warehouse type (only set when source_type === "warehouse") */
  warehouse_type?: WarehouseType;
  /** Fully qualified table name (only set when source_type === "warehouse") */
  warehouse_table?: string;
}

/** Detected domain hints for prompt specialization */

/** Detected domain hints for prompt specialization */
export type DataDomain = "financial" | "time_series" | "statistical" | "general";

/** A pairwise correlation between two numeric columns */

/** A pairwise correlation between two numeric columns */
export interface ColumnCorrelation {
  col_a: string;
  col_b: string;
  pearson: number;
}

export interface SheetInfo {
  name: string;
  rowCount: number;
  columnCount: number;
  headers?: string[];
  sampleRows?: string[][];
}

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

export interface WorkbookManifest {
  sheets: { name: string; csvId: string; schema: CSVSchema }[];
  relationships: SheetRelationship[];
}
