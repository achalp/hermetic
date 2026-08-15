import pg from "pg";
import type { PostgresConnectionConfig } from "@/lib/contracts/connection-configs";
import type {
  WarehouseTableInfo,
  WarehouseTableSchema,
  WarehouseColumnInfo,
} from "@/lib/contracts/warehouse-schema";
import type { WarehouseConnector } from "./connector";
import { csvValue } from "@/lib/csv/csv-util";
import { MAX_CSV_SIZE_BYTES } from "@/lib/constants";
import { logger } from "@/lib/logger";

/** Server-side cursor name + page size for the streaming extract path. */
const EXTRACT_CURSOR = "hermetic_extract_cur";
const EXTRACT_BATCH_ROWS = 5_000;

/** An Error the fetch loop / callers can recognize as a user-initiated abort. */
function abortError(): Error {
  const e = new Error("Query aborted");
  e.name = "AbortError";
  return e;
}

/**
 * Resolve the pg `ssl` option from the config.
 *
 * SSL OFF → no TLS (unchanged). SSL ON → VERIFY the server certificate by
 * default (`rejectUnauthorized: true`) so a MITM can't impersonate the server;
 * this is the security fix. A caller that genuinely needs a self-signed /
 * internal-CA cert opts in EXPLICITLY with `sslRejectUnauthorized: false` —
 * previously every SSL connection silently accepted any cert.
 *
 * Exported for unit testing (no DB connection needed).
 */
export function resolvePostgresSsl(
  config: Pick<PostgresConnectionConfig, "ssl" | "sslRejectUnauthorized">
): false | { rejectUnauthorized: boolean } {
  if (!config.ssl) return false;
  return { rejectUnauthorized: config.sslRejectUnauthorized !== false };
}

/**
 * Cancel a running statement server-side. The cursor's own connection is
 * blocked inside FETCH, so cancellation MUST come over a SECOND connection
 * calling pg_cancel_backend on the first's PID. Best-effort — the request is
 * already tearing down client-side.
 */
async function cancelBackend(pool: pg.Pool, pid: number): Promise<void> {
  try {
    const c = await pool.connect();
    try {
      await c.query("SELECT pg_cancel_backend($1)", [pid]);
    } finally {
      c.release();
    }
  } catch {
    // ignore — abort is best-effort
  }
}

export function createPostgresConnector(config: PostgresConnectionConfig): WarehouseConnector {
  // Use Pool instead of Client for automatic connection management,
  // reconnection on failure, and proper connection lifecycle handling.
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: resolvePostgresSsl(config),
    connectionTimeoutMillis: 10_000,
    max: 3, // small pool — this is an analytical tool, not a web server
    idleTimeoutMillis: 60_000,
    // Server-side statement timeout: kills long-running queries on the PG server itself.
    // This is critical — the Node.js query_timeout only cancels the client-side wait,
    // but the query keeps running on the server. statement_timeout kills it server-side.
    // default_transaction_read_only: server-side write rejection — defense in
    // depth behind assertReadOnlySql, whose first-keyword check was bypassable
    // via DML-in-CTE (code-quality-hardening review).
    options: "-c statement_timeout=120000 -c default_transaction_read_only=on",
  });

  const schemaName = config.schema ?? "public";

  return {
    async testConnection() {
      const client = await pool.connect();
      try {
        await client.query("SELECT 1");
      } finally {
        client.release();
      }
    },

    async listTables(): Promise<WarehouseTableInfo[]> {
      const res = await pool.query(
        `SELECT c.relname AS name,
                c.reltuples::bigint AS row_count,
                count(a.attname)::int AS column_count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         WHERE n.nspname = $1
           AND c.relkind IN ('r')
         GROUP BY c.relname, c.reltuples
         ORDER BY c.relname`,
        [schemaName]
      );
      return res.rows.map((r) => ({
        schema: schemaName,
        name: r.name,
        row_count_estimate: Math.max(0, Number(r.row_count)),
        column_count: r.column_count,
      }));
    },

    async introspectAllTables(): Promise<WarehouseTableSchema[]> {
      // Get all columns for all tables in one query
      const colRes = await pool.query(
        `SELECT table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name IN (
             SELECT c.relname FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relkind = 'r'
           )
         ORDER BY table_name, ordinal_position`,
        [schemaName]
      );

      // Get row counts
      const countRes = await pool.query(
        `SELECT c.relname AS name, c.reltuples::bigint AS row_count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind = 'r'`,
        [schemaName]
      );
      const rowCounts = new Map(
        countRes.rows.map((r) => [r.name, Math.max(0, Number(r.row_count))])
      );

      // Get primary keys
      const pkRes = await pool.query(
        `SELECT tc.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1
         ORDER BY tc.table_name, kcu.ordinal_position`,
        [schemaName]
      );
      const primaryKeys = new Map<string, string[]>();
      for (const r of pkRes.rows) {
        const existing = primaryKeys.get(r.table_name) ?? [];
        existing.push(r.column_name);
        primaryKeys.set(r.table_name, existing);
      }

      // Get foreign keys
      const fkRes = await pool.query(
        `SELECT tc.table_name, kcu.column_name,
                ccu.table_name AS references_table, ccu.column_name AS references_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
         WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1`,
        [schemaName]
      );
      const foreignKeys = new Map<
        string,
        { column: string; references_table: string; references_column: string }[]
      >();
      for (const r of fkRes.rows) {
        const existing = foreignKeys.get(r.table_name) ?? [];
        existing.push({
          column: r.column_name,
          references_table: r.references_table,
          references_column: r.references_column,
        });
        foreignKeys.set(r.table_name, existing);
      }

      // Group columns by table
      const tableColumns = new Map<string, WarehouseColumnInfo[]>();
      for (const r of colRes.rows) {
        const existing = tableColumns.get(r.table_name) ?? [];
        existing.push({
          name: r.column_name,
          type: r.data_type,
          nullable: r.is_nullable === "YES",
        });
        tableColumns.set(r.table_name, existing);
      }

      // Build table schemas
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

    async executeSQL(sql: string, signal?: AbortSignal): Promise<string> {
      if (signal?.aborted) throw abortError();

      // Reference STREAMING implementation. A server-side cursor pages the
      // result in bounded batches, so neither the full pg row-object array NOR
      // (past the byte budget) an unbounded CSV string is ever held whole in the
      // Node heap. This bounds MEMORY without bounding ROWS or changing the
      // query's answer — contrast a LIMIT/row-cap, which would silently truncate
      // a large extract or make an aggregate confidently wrong.
      // Register the abort handler BEFORE connecting so an abort that lands
      // while we're mid-setup isn't lost. Until the backend PID is known there
      // is no server statement to cancel; once it is, cancel immediately if the
      // abort already happened, else on the next abort.
      let backendPid: number | undefined;
      let sawAbort = false;
      const onAbort = () => {
        sawAbort = true;
        if (backendPid !== undefined) void cancelBackend(pool, backendPid);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const client = await pool.connect();
      let inTxn = false;
      try {
        const pidRes = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        backendPid = Number(pidRes.rows[0]?.pid);
        if (sawAbort) void cancelBackend(pool, backendPid); // abort raced setup

        // Read-only txn (the pool already forces default_transaction_read_only)
        // holding a cursor over the EXACT user SELECT — DECLARE wraps it, it does
        // not rewrite or LIMIT it. Strip a trailing `;` so it nests cleanly.
        const inner = sql.trim().replace(/;\s*$/, "");
        await client.query("BEGIN");
        inTxn = true;
        await client.query(`DECLARE ${EXTRACT_CURSOR} NO SCROLL CURSOR FOR ${inner}`);

        let headers: string[] | null = null;
        const lines: string[] = [];
        let bytes = 0;
        let dataRows = 0;
        let truncated = false;

        for (;;) {
          if (signal?.aborted) throw abortError();
          const batch = await client.query(
            `FETCH FORWARD ${EXTRACT_BATCH_ROWS} FROM ${EXTRACT_CURSOR}`
          );
          if (headers === null) {
            headers = batch.fields.map((f) => f.name);
            const headerLine = headers.map(csvValue).join(",");
            lines.push(headerLine);
            bytes += Buffer.byteLength(headerLine) + 1;
          }
          if (batch.rows.length === 0) break;
          for (const row of batch.rows as Record<string, unknown>[]) {
            const line = headers.map((h) => csvValue(row[h])).join(",");
            const lineBytes = Buffer.byteLength(line) + 1;
            if (bytes + lineBytes > MAX_CSV_SIZE_BYTES) {
              truncated = true;
              break;
            }
            lines.push(line);
            bytes += lineBytes;
            dataRows++;
          }
          if (truncated) break;
          if (batch.rows.length < EXTRACT_BATCH_ROWS) break; // cursor exhausted
        }

        if (truncated) {
          // BYTE-budget backstop (never a silent ROW cap): stop at the budget and
          // materialize the complete rows gathered so far. Disclosed via log —
          // the string-typed executeSQL contract (shared by callers this change
          // can't touch) has no channel to return a truncation flag.
          logger.warn("Postgres result hit byte budget; materialized a truncated prefix", {
            maxBytes: MAX_CSV_SIZE_BYTES,
            rows: dataRows,
          });
        }

        // No data rows → empty string, matching the prior contract.
        if (dataRows === 0) return "";
        return lines.join("\n") + "\n";
      } finally {
        signal?.removeEventListener("abort", onAbort);
        if (inTxn) await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    },

    async close() {
      await pool.end().catch(() => {});
    },
  };
}
