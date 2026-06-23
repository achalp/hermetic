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
    // Large materialization pulls (up to WAREHOUSE_MAX_ROWS) can take a while to
    // scan + transfer; 120s was aborting them mid-stream ("socket closed before
    // response fully read").
    request_timeout: 300_000,
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

    async getScanSafeWindow(table: string, dateColumn: string, budgetRows: number) {
      const tbl = table.includes(".") ? table.split(".").pop()! : table;

      // Two metadata sources, both no-full-scan:
      //  1. system.parts (min_time/max_time/rows) — cleanest, but some readonly
      //     users lack SELECT on it ("Not enough privileges").
      //  2. min/max(dateColumn) + count() on the table itself — the readonly user
      //     CAN read the table, and min/max on an indexed time column reads the
      //     index (no full scan). Works where system.parts is denied.
      const fromParts = async (): Promise<{ minT: number; maxT: number; total: number } | null> => {
        try {
          const result = await client.query({
            query: `SELECT toUnixTimestamp(min(min_time)) AS min_t,
                           toUnixTimestamp(max(max_time)) AS max_t,
                           sum(rows) AS total
                    FROM system.parts
                    WHERE database = currentDatabase() AND table = {tbl:String} AND active`,
            query_params: { tbl },
            format: "JSONEachRow",
          });
          const r = (await result.json<{ min_t: number; max_t: number; total: number }>())[0];
          const minT = Number(r?.min_t),
            maxT = Number(r?.max_t),
            total = Number(r?.total);
          return total && maxT && minT && maxT > minT ? { minT, maxT, total } : null;
        } catch {
          return null;
        }
      };

      const fromTable = async (): Promise<{ minT: number; maxT: number; total: number } | null> => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dateColumn)) return null; // identifier guard
        try {
          // min/max only reads the index (no full scan) when dateColumn is the
          // FIRST sort-key column. system.tables.sorting_key is granted even where
          // system.parts isn't. If it's not the sort-key prefix, a min/max would
          // full-scan and fail noisily — so skip and fall back to the LLM window.
          const skResult = await client.query({
            query: `SELECT sorting_key FROM system.tables
                    WHERE database = currentDatabase() AND name = {tbl:String}`,
            query_params: { tbl },
            format: "JSONEachRow",
          });
          const sortingKey = (await skResult.json<{ sorting_key: string }>())[0]?.sorting_key ?? "";
          const firstKey = sortingKey.split(",")[0]?.trim().replace(/`/g, "");
          if (firstKey !== dateColumn) return null;

          const result = await client.query({
            query: `SELECT toUnixTimestamp(min(\`${dateColumn}\`)) AS min_t,
                           toUnixTimestamp(max(\`${dateColumn}\`)) AS max_t,
                           count() AS total
                    FROM \`${tbl}\``,
            format: "JSONEachRow",
          });
          const r = (await result.json<{ min_t: number; max_t: number; total: number }>())[0];
          const minT = Number(r?.min_t),
            maxT = Number(r?.max_t),
            total = Number(r?.total);
          return total && maxT && minT && maxT > minT ? { minT, maxT, total } : null;
        } catch {
          return null;
        }
      };

      const range = (await fromParts()) ?? (await fromTable());
      if (!range) return null;
      if (range.total <= budgetRows) return null; // whole table fits — no window

      const spanSec = range.maxT - range.minT;
      const rowsPerSec = range.total / spanSec;
      const windowSec = Math.min(spanSec, Math.ceil(budgetRows / rowsPerSec));
      const startT = range.maxT - windowSec;
      const fmt = (t: number) => new Date(t * 1000).toISOString().slice(0, 19).replace("T", " ");
      return {
        start: fmt(startT),
        end: fmt(range.maxT),
        column: dateColumn,
        estimatedRows: Math.round(rowsPerSec * windowSec),
      };
    },

    async close() {
      await client.close();
    },
  };
}
