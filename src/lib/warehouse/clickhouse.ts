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
    request_timeout: 120_000,
  });

  return {
    async testConnection() {
      await client.ping();
    },

    async listTables(): Promise<WarehouseTableInfo[]> {
      const result = await client.query({
        query: `SELECT t.name, t.total_rows, count(c.name) AS col_count
                FROM system.tables t
                LEFT JOIN system.columns c ON c.database = t.database AND c.table = t.name
                WHERE t.database = currentDatabase()
                  AND t.engine NOT IN ('View', 'MaterializedView', 'Dictionary', 'SystemLog')
                  AND t.name NOT LIKE '.%'
                GROUP BY t.name, t.total_rows
                ORDER BY t.name`,
        format: "JSONEachRow",
      });
      const rows = await result.json<{ name: string; total_rows: string; col_count: string }>();
      return rows.map((r) => ({
        schema: config.database,
        name: r.name,
        row_count_estimate: Number(r.total_rows),
        column_count: Number(r.col_count),
      }));
    },

    async introspectAllTables(): Promise<WarehouseTableSchema[]> {
      // First get the list of real tables (not views, system tables, etc.)
      const tableResult = await client.query({
        query: `SELECT name, total_rows
                FROM system.tables
                WHERE database = currentDatabase()
                  AND engine NOT IN ('View', 'MaterializedView', 'Dictionary', 'SystemLog')
                  AND name NOT LIKE '.%'`,
        format: "JSONEachRow",
      });
      const tableRows = await tableResult.json<{ name: string; total_rows: string }>();
      const tableNames = new Set(tableRows.map((r) => r.name));
      const rowCounts = new Map(tableRows.map((r) => [r.name, Number(r.total_rows)]));

      if (tableNames.size === 0) {
        return [];
      }

      // Get columns only for real tables
      const colResult = await client.query({
        query: `SELECT table, name, type
                FROM system.columns
                WHERE database = currentDatabase()
                  AND table IN (
                    SELECT name FROM system.tables
                    WHERE database = currentDatabase()
                      AND engine NOT IN ('View', 'MaterializedView', 'Dictionary', 'SystemLog')
                      AND name NOT LIKE '.%'
                  )
                ORDER BY table, position`,
        format: "JSONEachRow",
      });
      const colRows = await colResult.json<{ table: string; name: string; type: string }>();

      // Group columns by table
      const tableColumns = new Map<string, WarehouseColumnInfo[]>();
      for (const r of colRows) {
        if (!tableNames.has(r.table)) continue;
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
