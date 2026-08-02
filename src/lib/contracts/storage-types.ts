/**
 * Persisted-record shapes: stored datasets, history, saved vizs, conversation turns.
 * Split from lib/types.ts (fan-in 85) — modularization M1-1a, spec S3.3.
 */

import type { CSVSchema } from "@/lib/contracts/data-schema";
import type { WarehouseType, WarehouseConnectionConfig } from "@/lib/contracts/connection-configs";
import type { WarehouseTableInfo, WarehouseTableSchema } from "@/lib/contracts/warehouse-schema";

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

export interface ConversationEntry {
  question: string;
  specSummary: string;
}

/** Structured record of a single analysis turn for follow-up context */

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
  /**
   * Warehouse turns only: the SQL that produced this turn's snapshot. Lets a
   * follow-up's SQL generation inherit the exact tables, joins, filters, and
   * scan window (minimal-edit) instead of re-deriving the population blind.
   * SQL is code, not data — sharing it does not violate blind execution.
   */
  sql?: string;
}

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
