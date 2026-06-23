import type {
  WarehouseConnectionConfig,
  WarehouseTableInfo,
  WarehouseTableSchema,
} from "@/lib/types";
import { createPostgresConnector } from "./postgres";
import { createBigQueryConnector } from "./bigquery";
import { createClickHouseConnector } from "./clickhouse";
import { createTrinoConnector } from "./trino";
import { createHiveConnector } from "./hive";
import { createSnowflakeConnector } from "./snowflake";
import { createDatabricksConnector } from "./databricks";

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
  /** Execute a SQL query and return results as CSV text */
  executeSQL(sql: string): Promise<string>;
  /**
   * Compute a recent time window on `table` that holds ~`budgetRows` rows, using
   * engine METADATA only (no table scan — safe under read-only). Lets the
   * materialization bound its scan deterministically instead of the LLM guessing
   * a window and failing with "rows to read exceeded". Returns null when the
   * engine can't size it cheaply (no time-partition metadata) or the whole table
   * already fits the budget. Optional — engines without cheap metadata omit it.
   */
  getScanSafeWindow?(table: string, budgetRows: number): Promise<ScanWindow | null>;
  close(): Promise<void>;
}

export function createConnector(config: WarehouseConnectionConfig): WarehouseConnector {
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
}
