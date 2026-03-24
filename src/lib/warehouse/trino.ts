import { Trino, BasicAuth } from "trino-client";
import type {
  TrinoConnectionConfig,
  WarehouseTableInfo,
  WarehouseTableSchema,
  WarehouseColumnInfo,
} from "@/lib/types";
import type { WarehouseConnector } from "./connector";

/** Convert a value to a CSV-safe string */
function csvValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
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

  const trino = Trino.create(trinoConfig);
  const catalogName = config.catalog;
  const schemaName = config.schema;

  /** Execute a query and collect all rows */
  async function runQuery(sql: string): Promise<{ columns: string[]; rows: unknown[][] }> {
    const iter = await trino.query(sql);
    const columns: string[] = [];
    const rows: unknown[][] = [];

    let result = await iter.next();
    while (!result.done) {
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
         WHERE table_schema = '${schemaName}'
           AND table_type IN ('BASE TABLE', 'TABLE')
         ORDER BY table_name`
      );

      // Get column counts per table
      const { rows: colRows } = await runQuery(
        `SELECT table_name, count(*) AS col_count
         FROM ${catalogName}.information_schema.columns
         WHERE table_schema = '${schemaName}'
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
         WHERE table_schema = '${schemaName}'
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

    async executeSQL(sql: string): Promise<string> {
      const { columns, rows } = await runQuery(sql);

      if (rows.length === 0) return "";

      const lines = [columns.map(csvValue).join(",")];
      for (const row of rows) {
        lines.push(row.map(csvValue).join(","));
      }
      return lines.join("\n") + "\n";
    },

    async close() {
      // trino-client is stateless HTTP — no persistent connection to close
    },
  };
}
