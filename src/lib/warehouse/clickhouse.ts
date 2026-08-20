import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type { ClickHouseConnectionConfig } from "@/lib/contracts/connection-configs";
import type {
  WarehouseTableInfo,
  WarehouseTableSchema,
  WarehouseColumnInfo,
} from "@/lib/contracts/warehouse-schema";
import type { WarehouseConnector } from "./connector";
import { MAX_CSV_SIZE_BYTES } from "@/lib/constants";

export function createClickHouseConnector(config: ClickHouseConnectionConfig): WarehouseConnector {
  const protocol = config.ssl ? "https" : "http";
  const makeClient = (requestReadonly: boolean): ClickHouseClient =>
    createClient({
      url: `${protocol}://${config.host}:${config.port}`,
      username: config.user,
      password: config.password,
      database: config.database,
      // Large materialization pulls (up to WAREHOUSE_MAX_ROWS) can take a while to
      // scan + transfer; 120s was aborting them mid-stream ("socket closed before
      // response fully read").
      request_timeout: 300_000,
      // Server-side write rejection — defense in depth behind assertReadOnlySql,
      // whose first-keyword check was bypassable via DML-in-CTE
      // (code-quality-hardening review). readonly=2 (not 1) so per-request
      // settings still work; the readonly setting itself cannot be unset at 2.
      ...(requestReadonly ? { clickhouse_settings: { readonly: "2" as const } } : {}),
    });

  let client: ClickHouseClient = makeClient(true);
  let fellBack = false;

  /**
   * A user whose profile is ALREADY readonly=1 cannot have ANY setting
   * modified per-request — including tightening `readonly` itself — so the
   * defense-in-depth setting breaks exactly the servers that need no defense
   * (found live against play.clickhouse.com). On that specific refusal, fall
   * back once to a client that doesn't send the setting: the server's own
   * readonly enforcement is strictly stronger than what we were asking for.
   */
  async function run<T>(fn: (c: ClickHouseClient) => Promise<T>): Promise<T> {
    try {
      return await fn(client);
    } catch (err) {
      const readonlyRefusal =
        !fellBack &&
        err instanceof Error &&
        (err as { type?: string }).type === "READONLY" &&
        /modify 'readonly' setting/i.test(err.message);
      if (!readonlyRefusal) throw err;
      fellBack = true;
      void client.close().catch(() => {});
      client = makeClient(false);
      return await fn(client);
    }
  }

  return {
    async testConnection() {
      await run((c) => c.ping());
    },

    async listTables(): Promise<WarehouseTableInfo[]> {
      const result = await run((c) =>
        c.query({
          query: `SELECT t.name, t.total_rows, count(c.name) AS col_count
                FROM system.tables t
                LEFT JOIN system.columns c ON c.database = t.database AND c.table = t.name
                WHERE t.database = currentDatabase()
                  AND t.engine NOT IN ('View', 'MaterializedView', 'Dictionary', 'SystemLog')
                  AND t.name NOT LIKE '.%'
                GROUP BY t.name, t.total_rows
                ORDER BY t.name`,
          format: "JSONEachRow",
        })
      );
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
      const tableResult = await run((c) =>
        c.query({
          query: `SELECT name, total_rows
                FROM system.tables
                WHERE database = currentDatabase()
                  AND engine NOT IN ('View', 'MaterializedView', 'Dictionary', 'SystemLog')
                  AND name NOT LIKE '.%'`,
          format: "JSONEachRow",
        })
      );
      const tableRows = await tableResult.json<{ name: string; total_rows: string }>();
      const tableNames = new Set(tableRows.map((r) => r.name));
      const rowCounts = new Map(tableRows.map((r) => [r.name, Number(r.total_rows)]));

      if (tableNames.size === 0) {
        return [];
      }

      // Get columns only for real tables
      const colResult = await run((c) =>
        c.query({
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
        })
      );
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

    async executeSQL(sql: string, signal?: AbortSignal): Promise<string> {
      if (signal?.aborted) {
        const e = new Error("Query aborted");
        e.name = "AbortError";
        throw e;
      }
      // abort_signal gives real server-side cancellation: on Stop the ClickHouse
      // client aborts the HTTP request and the server stops the query.
      // SERVER-SIDE byte budget (the OOM backstop): max_result_bytes caps the
      // result and result_overflow_mode='break' returns the complete rows
      // gathered so far rather than erroring, so result.text() buffers a BOUNDED
      // CSV (~100MB) — the server, not Node, enforces the cap. CSVWithNames rows
      // stay complete because the break happens at a block boundary.
      const result = await run((c) =>
        c.query({
          query: sql,
          format: "CSVWithNames",
          abort_signal: signal,
          clickhouse_settings: {
            max_result_bytes: String(MAX_CSV_SIZE_BYTES),
            result_overflow_mode: "break",
          },
        })
      );
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
        const skResult = await run((c) =>
          c.query({
            query: `SELECT sorting_key FROM system.tables
                  WHERE database = currentDatabase() AND name = {tbl:String}`,
            query_params: { tbl },
            format: "JSONEachRow",
          })
        );
        const sortingKey = (await skResult.json<{ sorting_key: string }>())[0]?.sorting_key ?? "";
        const firstKey = sortingKey.split(",")[0]?.trim().replace(/`/g, "");
        if (firstKey === dateColumn) {
          const typeResult = await run((c) =>
            c.query({
              query: `SELECT type FROM system.columns
                    WHERE database = currentDatabase() AND table = {tbl:String} AND name = {col:String}`,
              query_params: { tbl, col: dateColumn },
              format: "JSONEachRow",
            })
          );
          const colType = (await typeResult.json<{ type: string }>())[0]?.type ?? "";
          // Date / Date32 (incl. Nullable/LowCardinality wrappers) — but NOT DateTime.
          isDateOnly = /\bDate(32)?\b/.test(colType) && !/DateTime/.test(colType);
          const result = await run((c) =>
            c.query({
              query: `SELECT toUnixTimestamp(min(\`${dateColumn}\`)) AS min_t,
                           toUnixTimestamp(max(\`${dateColumn}\`)) AS max_t,
                           count() AS total
                    FROM \`${tbl}\``,
              format: "JSONEachRow",
            })
          );
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
