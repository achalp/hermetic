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
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dateColumn)) return null; // identifier guard

      // Derive the time span from the TABLE itself (not system.parts — many
      // read-only users lack SELECT on it, and the denial is just noise). min/max
      // only reads the index (no full scan) when dateColumn is the FIRST sort-key
      // column, which we check cheaply via system.tables.sorting_key (granted even
      // where system.parts isn't). If it's not the sort-key prefix we return null
      // and the caller falls back to the LLM-chosen window — quietly.
      //
      // We also read the column TYPE: a `Date` column can't be compared to a
      // datetime literal ('2026-07-01 21:30:04' → TYPE_MISMATCH), so the window
      // must be formatted day-granular for Date columns and datetime for DateTime.
      let range: { minT: number; maxT: number; total: number } | null = null;
      let isDateOnly = false;
      try {
        const skResult = await client.query({
          query: `SELECT sorting_key FROM system.tables
                  WHERE database = currentDatabase() AND name = {tbl:String}`,
          query_params: { tbl },
          format: "JSONEachRow",
        });
        const sortingKey = (await skResult.json<{ sorting_key: string }>())[0]?.sorting_key ?? "";
        const firstKey = sortingKey.split(",")[0]?.trim().replace(/`/g, "");
        if (firstKey === dateColumn) {
          const typeResult = await client.query({
            query: `SELECT type FROM system.columns
                    WHERE database = currentDatabase() AND table = {tbl:String} AND name = {col:String}`,
            query_params: { tbl, col: dateColumn },
            format: "JSONEachRow",
          });
          const colType = (await typeResult.json<{ type: string }>())[0]?.type ?? "";
          // Date / Date32 (incl. Nullable/LowCardinality wrappers) — but NOT DateTime.
          isDateOnly = /\bDate(32)?\b/.test(colType) && !/DateTime/.test(colType);
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
          if (total && maxT && minT && maxT > minT) range = { minT, maxT, total };
        }
      } catch {
        return null;
      }

      if (!range) return null;
      if (range.total <= budgetRows) return null; // whole table fits — no window

      const spanSec = range.maxT - range.minT;
      const rowsPerSec = range.total / spanSec;
      const DAY = 86400;
      let windowSec = Math.min(spanSec, Math.ceil(budgetRows / rowsPerSec));
      // A Date column's finest bound is a day — never emit a sub-day window for
      // it (both because a datetime literal is a type error, and because a
      // sub-day slice of a Date column is meaningless). Floor to one full day.
      if (isDateOnly) windowSec = Math.min(spanSec, Math.max(windowSec, DAY));
      const startT = range.maxT - windowSec;
      const fmtDateTime = (t: number) =>
        new Date(t * 1000).toISOString().slice(0, 19).replace("T", " ");
      const fmtDate = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
      const fmt = isDateOnly ? fmtDate : fmtDateTime;
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
