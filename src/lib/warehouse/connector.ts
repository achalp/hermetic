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

export interface WarehouseConnector {
  testConnection(): Promise<void>;
  listTables(): Promise<WarehouseTableInfo[]>;
  /** Introspect all tables: columns, types, PKs, FKs */
  introspectAllTables(): Promise<WarehouseTableSchema[]>;
  /** Execute a SQL query and return results as CSV text */
  executeSQL(sql: string): Promise<string>;
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
  }
}
