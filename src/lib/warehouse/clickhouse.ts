import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type {
  ClickHouseConnectionConfig,
  WarehouseTableInfo,
  WarehouseTableSchema,
  WarehouseColumnInfo,
} from "@/lib/types";
import type { WarehouseConnector } from "./connector";

export function createClickHouseConnector(config: ClickHouseConnectionConfig): WarehouseConnector {
  const protocol = config.ssl ? "https" : "http";
  const client: ClickHouseClient = createClient({
    url: `${protocol}://${config.host}:${config.port}`,
    username: config.user,
    password: config.password,
    database: config.database,
    request_timeout: 60_000,
  });

  return {
    async testConnection() {
      await client.ping();
    },

    async listTables(): Promise<WarehouseTableInfo[]> {
      const result = await client.query({
        query: `SELECT name, total_rows, total_columns
                FROM system.tables
                WHERE database = currentDatabase()
                  AND engine NOT IN ('View')
                ORDER BY name`,
        format: "JSONEachRow",
      });
      const rows = await result.json<{ name: string; total_rows: string; total_columns: string }>();
      return rows.map((r) => ({
        schema: config.database,
        name: r.name,
        row_count_estimate: Number(r.total_rows),
        column_count: Number(r.total_columns),
      }));
    },

    async introspectAllTables(): Promise<WarehouseTableSchema[]> {
      // Get all columns
      const colResult = await client.query({
        query: `SELECT table, name, type
                FROM system.columns
                WHERE database = currentDatabase()
                ORDER BY table, position`,
        format: "JSONEachRow",
      });
      const colRows = await colResult.json<{ table: string; name: string; type: string }>();

      // Get row counts
      const tableResult = await client.query({
        query: `SELECT name, total_rows
                FROM system.tables
                WHERE database = currentDatabase() AND engine NOT IN ('View')`,
        format: "JSONEachRow",
      });
      const tableRows = await tableResult.json<{ name: string; total_rows: string }>();
      const rowCounts = new Map(tableRows.map((r) => [r.name, Number(r.total_rows)]));

      // ClickHouse doesn't have traditional PKs/FKs
      // Group columns by table
      const tableColumns = new Map<string, WarehouseColumnInfo[]>();
      for (const r of colRows) {
        const existing = tableColumns.get(r.table) ?? [];
        existing.push({
          name: r.name,
          type: r.type,
          nullable: r.type.startsWith("Nullable"),
        });
        tableColumns.set(r.table, existing);
      }

      const schemas: WarehouseTableSchema[] = [];
      for (const [tableName, columns] of tableColumns) {
        schemas.push({
          schema: config.database,
          name: tableName,
          columns,
          row_count_estimate: rowCounts.get(tableName) ?? 0,
        });
      }

      return schemas;
    },

    async executeSQL(sql: string): Promise<string> {
      const result = await client.query({
        query: sql,
        format: "CSVWithNames",
      });
      return await result.text();
    },

    async close() {
      await client.close();
    },
  };
}
