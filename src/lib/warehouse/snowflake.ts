/**
 * Snowflake warehouse connector.
 *
 * Uses the official `snowflake-sdk` (callback-based, ~CommonJS API).
 * v1 supports password auth only. OAuth + keypair are deferred.
 *
 * Schema introspection uses INFORMATION_SCHEMA.COLUMNS / TABLE_CONSTRAINTS.
 * Identifiers passed to Snowflake unquoted are uppercased automatically;
 * we therefore uppercase user-provided database/schema names for lookups.
 */

import snowflake from "snowflake-sdk";
import type {
  SnowflakeConnectionConfig,
  WarehouseTableInfo,
  WarehouseTableSchema,
  WarehouseColumnInfo,
} from "@/lib/types";
import type { WarehouseConnector } from "./connector";

interface SnowflakeRow {
  [key: string]: unknown;
}

/** Convert a value to a CSV-safe string, handling nulls properly. */
function csvValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (v instanceof Date) {
    s = v.toISOString();
  } else if (typeof v === "object") {
    s = JSON.stringify(v);
  } else {
    s = String(v);
  }
  return s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

export function createSnowflakeConnector(config: SnowflakeConnectionConfig): WarehouseConnector {
  const databaseName = config.database.toUpperCase();
  const schemaName = (config.schema ?? "PUBLIC").toUpperCase();

  // Single connection — Snowflake's Node SDK doesn't ship a pool primitive.
  const connection = snowflake.createConnection({
    account: config.account,
    username: config.user,
    password: config.password,
    database: databaseName,
    schema: schemaName,
    warehouse: config.warehouse,
    role: config.role,
    clientSessionKeepAlive: false,
  });

  const connectPromise = new Promise<void>((resolve, reject) => {
    connection.connect((err) => {
      if (err) reject(new Error(err.message ?? String(err)));
      else resolve();
    });
  });

  function executeQuery<T = SnowflakeRow>(sqlText: string): Promise<T[]> {
    return new Promise((resolve, reject) => {
      connection.execute({
        sqlText,
        complete: (err, _stmt, rows) => {
          if (err) {
            reject(new Error(err.message ?? String(err)));
          } else {
            resolve((rows ?? []) as unknown as T[]);
          }
        },
      });
    });
  }

  return {
    async testConnection() {
      await connectPromise;
      await executeQuery("SELECT 1");
    },

    async listTables(): Promise<WarehouseTableInfo[]> {
      await connectPromise;
      const rows = await executeQuery<{
        TABLE_NAME?: string;
        ROW_COUNT?: number | string | null;
        COLUMN_COUNT?: number | string | null;
      }>(
        `SELECT t.table_name AS TABLE_NAME,
                t.row_count AS ROW_COUNT,
                COUNT(c.column_name) AS COLUMN_COUNT
         FROM ${databaseName}.INFORMATION_SCHEMA.TABLES t
         LEFT JOIN ${databaseName}.INFORMATION_SCHEMA.COLUMNS c
           ON c.table_schema = t.table_schema AND c.table_name = t.table_name
         WHERE t.table_schema = '${schemaName}' AND t.table_type = 'BASE TABLE'
         GROUP BY t.table_name, t.row_count
         ORDER BY t.table_name`
      );
      return rows.map((r) => ({
        schema: schemaName,
        name: String(r.TABLE_NAME ?? ""),
        row_count_estimate: Math.max(0, Number(r.ROW_COUNT ?? 0)),
        column_count: Number(r.COLUMN_COUNT ?? 0),
      }));
    },

    async introspectAllTables(): Promise<WarehouseTableSchema[]> {
      await connectPromise;

      const colRows = await executeQuery<{
        TABLE_NAME?: string;
        COLUMN_NAME?: string;
        DATA_TYPE?: string;
        IS_NULLABLE?: string;
      }>(
        `SELECT table_name AS TABLE_NAME,
                column_name AS COLUMN_NAME,
                data_type AS DATA_TYPE,
                is_nullable AS IS_NULLABLE
         FROM ${databaseName}.INFORMATION_SCHEMA.COLUMNS
         WHERE table_schema = '${schemaName}'
         ORDER BY table_name, ordinal_position`
      );

      const countRows = await executeQuery<{
        TABLE_NAME?: string;
        ROW_COUNT?: number | string | null;
      }>(
        `SELECT table_name AS TABLE_NAME, row_count AS ROW_COUNT
         FROM ${databaseName}.INFORMATION_SCHEMA.TABLES
         WHERE table_schema = '${schemaName}' AND table_type = 'BASE TABLE'`
      );
      const rowCounts = new Map<string, number>(
        countRows.map((r) => [String(r.TABLE_NAME ?? ""), Math.max(0, Number(r.ROW_COUNT ?? 0))])
      );

      // Snowflake exposes PK / FK constraints through TABLE_CONSTRAINTS + KEY_COLUMN_USAGE
      const pkRows = await executeQuery<{
        TABLE_NAME?: string;
        COLUMN_NAME?: string;
      }>(
        `SELECT tc.table_name AS TABLE_NAME, kcu.column_name AS COLUMN_NAME
         FROM ${databaseName}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN ${databaseName}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = '${schemaName}'
         ORDER BY tc.table_name, kcu.ordinal_position`
      );
      const primaryKeys = new Map<string, string[]>();
      for (const r of pkRows) {
        const name = String(r.TABLE_NAME ?? "");
        const col = String(r.COLUMN_NAME ?? "");
        const list = primaryKeys.get(name) ?? [];
        list.push(col);
        primaryKeys.set(name, list);
      }

      const fkRows = await executeQuery<{
        TABLE_NAME?: string;
        COLUMN_NAME?: string;
        REFERENCES_TABLE?: string;
        REFERENCES_COLUMN?: string;
      }>(
        `SELECT tc.table_name AS TABLE_NAME,
                kcu.column_name AS COLUMN_NAME,
                ccu.table_name AS REFERENCES_TABLE,
                ccu.column_name AS REFERENCES_COLUMN
         FROM ${databaseName}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
         JOIN ${databaseName}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
         JOIN ${databaseName}.INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu
           ON tc.constraint_name = ccu.constraint_name
          AND tc.table_schema = ccu.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = '${schemaName}'`
      );
      const foreignKeys = new Map<
        string,
        { column: string; references_table: string; references_column: string }[]
      >();
      for (const r of fkRows) {
        const name = String(r.TABLE_NAME ?? "");
        const list = foreignKeys.get(name) ?? [];
        list.push({
          column: String(r.COLUMN_NAME ?? ""),
          references_table: String(r.REFERENCES_TABLE ?? ""),
          references_column: String(r.REFERENCES_COLUMN ?? ""),
        });
        foreignKeys.set(name, list);
      }

      const tableColumns = new Map<string, WarehouseColumnInfo[]>();
      for (const r of colRows) {
        const tname = String(r.TABLE_NAME ?? "");
        const list = tableColumns.get(tname) ?? [];
        list.push({
          name: String(r.COLUMN_NAME ?? ""),
          type: String(r.DATA_TYPE ?? ""),
          nullable: String(r.IS_NULLABLE ?? "YES") === "YES",
        });
        tableColumns.set(tname, list);
      }

      const schemas: WarehouseTableSchema[] = [];
      for (const [tableName, columns] of tableColumns) {
        schemas.push({
          schema: schemaName,
          name: tableName,
          columns,
          row_count_estimate: rowCounts.get(tableName) ?? 0,
          primary_key: primaryKeys.get(tableName),
          foreign_keys: foreignKeys.get(tableName),
        });
      }
      return schemas;
    },

    async executeSQL(sql: string): Promise<string> {
      await connectPromise;
      const rows = await executeQuery<SnowflakeRow>(sql);
      if (rows.length === 0) return "";

      const headers = Object.keys(rows[0]);
      const lines = [headers.map(csvValue).join(",")];
      for (const row of rows) {
        lines.push(headers.map((h) => csvValue(row[h])).join(","));
      }
      return lines.join("\n") + "\n";
    },

    async close() {
      await new Promise<void>((resolve) => {
        try {
          connection.destroy(() => resolve());
        } catch {
          resolve();
        }
      });
    },
  };
}
