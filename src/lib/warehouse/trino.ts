import { Trino, BasicAuth } from "trino-client";
import type { TrinoConnectionConfig } from "@/lib/contracts/connection-configs";
import type {
  WarehouseTableInfo,
  WarehouseTableSchema,
  WarehouseColumnInfo,
} from "@/lib/contracts/warehouse-schema";
import type { WarehouseConnector } from "./connector";
import { createCsvBudget } from "@/lib/csv/csv-util";
import { MAX_CSV_SIZE_BYTES } from "@/lib/constants";
import { logger } from "@/lib/logger";

/** Convert a value to a CSV-safe string */
/** Escape a SQL string literal value (prevents injection via config values) */
function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''");
}

export function createTrinoConnector(config: TrinoConnectionConfig): WarehouseConnector {
  const protocol = config.ssl ? "https" : "http";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trinoConfig: Record<string, any> = {
    server: `${protocol}://${config.host}:${config.port}`,
    catalog: config.catalog,
    schema: config.schema,
  };
  if (config.password) {
    trinoConfig.auth = new BasicAuth(config.user, config.password);
  }

  // No session-level read-only mode in Trino's client protocol (access control
  // is server-side catalog config) — assertReadOnlySql is the only write gate
  // on this connector.
  const trino = Trino.create(trinoConfig);
  const catalogName = config.catalog;
  const schemaName = config.schema;

  /** Execute a query and collect all rows */
  async function runQuery(
    sql: string,
    signal?: AbortSignal
  ): Promise<{ columns: string[]; rows: unknown[][] }> {
    const iter = await trino.query(sql);
    const columns: string[] = [];
    const rows: unknown[][] = [];

    let result = await iter.next();
    while (!result.done) {
      if (signal?.aborted) {
        const e = new Error("Query aborted");
        e.name = "AbortError";
        throw e;
      }
      const qr = result.value;
      // Capture column names from first result with columns
      if (columns.length === 0 && qr.columns) {
        for (const col of qr.columns) {
          columns.push(col.name);
        }
      }
      if (qr.data) {
        for (const row of qr.data) {
          rows.push(row as unknown[]);
        }
      }
      result = await iter.next();
    }

    return { columns, rows };
  }

  return {
    async testConnection() {
      await runQuery("SELECT 1");
    },

    async listTables(): Promise<WarehouseTableInfo[]> {
      const { rows } = await runQuery(
        `SELECT table_name
         FROM ${catalogName}.information_schema.tables
         WHERE table_schema = '${escapeSqlString(schemaName)}'
           AND table_type IN ('BASE TABLE', 'TABLE')
         ORDER BY table_name`
      );

      // Get column counts per table
      const { rows: colRows } = await runQuery(
        `SELECT table_name, count(*) AS col_count
         FROM ${catalogName}.information_schema.columns
         WHERE table_schema = '${escapeSqlString(schemaName)}'
         GROUP BY table_name`
      );
      const colCounts = new Map<string, number>();
      for (const r of colRows) {
        colCounts.set(String(r[0]), Number(r[1]));
      }

      return rows.map((r) => ({
        schema: `${catalogName}.${schemaName}`,
        name: String(r[0]),
        row_count_estimate: 0, // Trino doesn't expose row counts cheaply
        column_count: colCounts.get(String(r[0])) ?? 0,
      }));
    },

    async introspectAllTables(): Promise<WarehouseTableSchema[]> {
      // Get all columns
      const { rows: colRows } = await runQuery(
        `SELECT table_name, column_name, data_type, is_nullable
         FROM ${catalogName}.information_schema.columns
         WHERE table_schema = '${escapeSqlString(schemaName)}'
         ORDER BY table_name, ordinal_position`
      );

      // Group columns by table
      const tableColumns = new Map<string, WarehouseColumnInfo[]>();
      for (const r of colRows) {
        const tableName = String(r[0]);
        const existing = tableColumns.get(tableName) ?? [];
        existing.push({
          name: String(r[1]),
          type: String(r[2]),
          nullable: String(r[3]) === "YES",
        });
        tableColumns.set(tableName, existing);
      }

      // Build schemas — Trino has no native FK support, rely on inferRelationships()
      const schemas: WarehouseTableSchema[] = [];
      for (const [tableName, columns] of tableColumns) {
        schemas.push({
          schema: `${catalogName}.${schemaName}`,
          name: tableName,
          columns,
          row_count_estimate: 0,
        });
      }

      return schemas;
    },

    // Streams the paged result STRAIGHT into the byte-budget CSV builder, so a
    // huge SELECT * stops at MAX_CSV_SIZE_BYTES instead of buffering the whole
    // result into one array (the OOM backstop; postgres.ts is the reference).
    // trino-client has no server-side cancel, so abort just stops consuming
    // pages, same as introspection's runQuery.
    async executeSQL(sql: string, signal?: AbortSignal): Promise<string> {
      const iter = await trino.query(sql);
      const columns: string[] = [];
      let budget: ReturnType<typeof createCsvBudget> | null = null;
      let result = await iter.next();
      while (!result.done) {
        if (signal?.aborted) {
          const e = new Error("Query aborted");
          e.name = "AbortError";
          throw e;
        }
        const qr = result.value;
        if (columns.length === 0 && qr.columns) {
          for (const col of qr.columns) columns.push(col.name);
          budget = createCsvBudget(columns, MAX_CSV_SIZE_BYTES);
        }
        if (qr.data && budget) {
          for (const row of qr.data as unknown[][]) {
            if (!budget.add(row)) {
              logger.warn("Trino result hit byte budget; materialized a truncated prefix", {
                maxBytes: MAX_CSV_SIZE_BYTES,
                rows: budget.rows(),
              });
              return budget.finish();
            }
          }
        }
        result = await iter.next();
      }
      return budget ? budget.finish() : "";
    },

    async close() {
      // trino-client is stateless HTTP — no persistent connection to close
    },
  };
}
