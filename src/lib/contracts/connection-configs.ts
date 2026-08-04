import type { WarehouseType } from "@/lib/contracts/warehouse-schema";
export type { WarehouseType };

/**
 * Warehouse connection credentials. SERVER + settings-forms only:
 * render/chart code must never import this module.
 * Split from lib/types.ts (fan-in 85) — modularization M1-1a, spec S3.3.
 */

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
