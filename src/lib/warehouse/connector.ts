import type { WarehouseConnectionConfig } from "@/lib/contracts/connection-configs";
import type { WarehouseTableInfo, WarehouseTableSchema } from "@/lib/contracts/warehouse-schema";
import { createPostgresConnector } from "./postgres";
import { createBigQueryConnector } from "./bigquery";
import { createClickHouseConnector } from "./clickhouse";
import { createTrinoConnector } from "./trino";
import { createHiveConnector } from "./hive";
import { createSnowflakeConnector } from "./snowflake";
import { createDatabricksConnector } from "./databricks";
import { assertReadOnlySql } from "./sql-guard";

/** A time window (inclusive start, inclusive end) sized to fit a row budget. */
export interface ScanWindow {
  /** Engine-formatted datetime, e.g. "2024-09-01 00:00:00". */
  start: string;
  end: string;
  /** The time column the window is measured on. */
  column: string;
  /** Estimated rows in the window (from metadata). */
  estimatedRows: number;
}

export interface WarehouseConnector {
  testConnection(): Promise<void>;
  listTables(): Promise<WarehouseTableInfo[]>;
  /** Introspect all tables: columns, types, PKs, FKs */
  introspectAllTables(): Promise<WarehouseTableSchema[]>;
  /**
   * Execute a SQL query and return results as CSV text.
   *
   * `signal` is OPTIONAL (backward-compatible — existing callers pass nothing).
   * When supplied and aborted, the connector cancels the query mid-flight:
   * Postgres cancels the running backend (pg_cancel_backend), BigQuery cancels
   * the server-side JOB (job.cancel — stops billing), and ClickHouse aborts the
   * HTTP request. Without it, executeSQL is uncancellable and a BigQuery job can
   * keep billing server-side up to BigQuery's 6h hard limit.
   */
  executeSQL(sql: string, signal?: AbortSignal): Promise<string>;
  /**
   * Compute a recent time window on `table` that holds ~`budgetRows` rows, using
   * engine METADATA only (no table scan — safe under read-only). Lets the
   * materialization bound its scan deterministically instead of the LLM guessing
   * a window and failing with "rows to read exceeded". Returns null when the
   * engine can't size it cheaply (no time-partition metadata) or the whole table
   * already fits the budget. Optional — engines without cheap metadata omit it.
   */
  getScanSafeWindow?(
    table: string,
    dateColumn: string,
    budgetRows: number
  ): Promise<ScanWindow | null>;
  close(): Promise<void>;
}

/**
 * Driver factory. Everything about an engine EXCEPT its driver (dialect
 * notes, prompt table naming, sample-query quoting, labels, display
 * name/color) lives in engine-descriptor.ts — this switch stays separate
 * only because the drivers are node-only imports and the descriptor must
 * stay client-safe. New-engine checklist: see engine-descriptor.ts header.
 */
export function createConnector(config: WarehouseConnectionConfig): WarehouseConnector {
  const connector = ((): WarehouseConnector => {
    switch (config.type) {
      case "postgresql":
        return createPostgresConnector(config);
      case "bigquery":
        return createBigQueryConnector(config);
      case "clickhouse":
        return createClickHouseConnector(config);
      case "trino":
        return createTrinoConnector(config);
      case "hive":
        return createHiveConnector(config);
      case "snowflake":
        return createSnowflakeConnector(config);
      case "databricks":
        return createDatabricksConnector(config);
    }
  })();

  // An unknown type falls out of the exhaustive switch as undefined at
  // runtime (routes 400 on it before ever calling this) — pinned contract.
  if (!connector) return connector;

  // Read-only gate at the single chokepoint every connector flows through:
  // whatever SQL reaches executeSQL (generated, edited, refresh, sample,
  // per-step) must be one SELECT/WITH statement. See assertReadOnlySql.
  const rawExecuteSQL = connector.executeSQL.bind(connector);
  connector.executeSQL = (sql: string, signal?: AbortSignal) => {
    assertReadOnlySql(sql);
    return rawExecuteSQL(sql, signal);
  };
  return connector;
}
