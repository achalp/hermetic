/**
 * Warehouse introspection shapes (tables, columns, analysis window).
 * Split from lib/types.ts (fan-in 85) — modularization M1-1a, spec S3.3.
 */

export type WarehouseType =
  "postgresql" | "bigquery" | "clickhouse" | "trino" | "hive" | "snowflake" | "databricks";

export interface WarehouseTableInfo {
  schema: string;
  name: string;
  row_count_estimate: number;
  column_count: number;
}

/** Column metadata for warehouse schema introspection (lightweight, for SQL generation) */

/** Column metadata for warehouse schema introspection (lightweight, for SQL generation) */
export interface WarehouseColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  /** Optional human-readable description (sourced from dbt docs when linked) */
  description?: string;
}

/** Full schema of a single warehouse table (for SQL generation context) */

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
