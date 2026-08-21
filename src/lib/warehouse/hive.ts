import { HiveClient, thrift, auth, connections } from "hive-driver";
import type { HiveConnectionConfig } from "@/lib/contracts/connection-configs";
import type {
  WarehouseTableInfo,
  WarehouseTableSchema,
  WarehouseColumnInfo,
} from "@/lib/contracts/warehouse-schema";
import type { WarehouseConnector } from "./connector";
import { createCsvBudget } from "@/lib/csv/csv-util";
import { MAX_CSV_SIZE_BYTES } from "@/lib/constants";
import { logger } from "@/lib/logger";

const { TCLIService_types } = thrift;

/**
 * Minimal structural view of the hive-driver session surface this connector
 * uses — the previous `any` left every session/operation call unchecked.
 */
interface HiveOperation {
  getSchema(): Promise<{ columns?: { columnName: string }[] } | null>;
  fetchChunk(opts: { maxRows: number }): Promise<unknown[]>;
  hasMoreRows(): Promise<boolean>;
  close(): Promise<unknown>;
}
interface HiveSession {
  executeStatement(sql: string, opts: { runAsync: boolean }): Promise<HiveOperation>;
  close(): Promise<unknown>;
}

/** Convert a value to a CSV-safe string */
export function createHiveConnector(config: HiveConnectionConfig): WarehouseConnector {
  // HiveServer2 has no session-level read-only switch (authorization lives in
  // Ranger/SQL-standard auth server-side) — assertReadOnlySql is the only
  // write gate on this connector.
  const client = new HiveClient(TCLIService_types, TCLIService_types);
  let session: HiveSession | null = null;
  /** Last listTables probe (tables + DESCRIBE rows), consumed AT MOST ONCE by
   *  the introspect that follows on a cold connect — see listTables (perf P15). */
  let lastProbe: { tables: string[]; described: Map<string, unknown[][]> } | null = null;
  let connected = false;

  const dbName = config.database || "default";

  async function ensureSession(): Promise<void> {
    if (session) return;

    // Build auth and connection based on auth method
    const authMethod = config.auth ?? "NONE";
    let authProvider;
    let connection;

    if (authMethod === "NOSASL") {
      authProvider = new auth.NoSaslAuthentication();
      connection = new connections.TcpConnection();
    } else if (authMethod === "LDAP" || authMethod === "NONE") {
      authProvider = new auth.PlainTcpAuthentication({
        username: config.user,
        password: config.password ?? "",
      });
      connection = new connections.TcpConnection();
    } else {
      // KERBEROS — use plain TCP as fallback (real Kerberos needs krb5 config)
      authProvider = new auth.PlainTcpAuthentication({
        username: config.user,
        password: config.password ?? "",
      });
      connection = new connections.TcpConnection();
    }

    await client.connect({ host: config.host, port: config.port }, connection, authProvider);
    connected = true;

    // Structural cast: hive-driver's own IOperation typings lag its runtime
    // shape (fetchChunk exists at runtime but not in the .d.ts) — the
    // interface above pins the surface this connector actually calls.
    session = (await client.openSession({
      client_protocol: TCLIService_types.TProtocolVersion.HIVE_CLI_SERVICE_PROTOCOL_V10,
    })) as unknown as HiveSession;

    // Switch to the target database
    if (dbName !== "default") {
      await runSessionQuery(`USE \`${dbName}\``);
    }
  }

  /** Execute a query on the current session and return rows */
  async function runSessionQuery(
    sql: string,
    signal?: AbortSignal
  ): Promise<{ columns: string[]; rows: unknown[][] }> {
    await ensureSession();
    if (!session) throw new Error("Hive session failed to open");

    const operation = await session.executeStatement(sql, {
      runAsync: false,
    });

    // try/finally mirrors executeSQL below: a getSchema/fetchChunk throw must
    // still close the operation handle, or every failed query leaks one on
    // the server side for the session's lifetime.
    try {
      const columns: string[] = [];
      const rows: unknown[][] = [];

      // Get schema (column names)
      const schema = await operation.getSchema();
      if (schema?.columns) {
        for (const col of schema.columns) {
          columns.push(col.columnName);
        }
      }

      // Fetch all rows
      let hasMore = true;
      while (hasMore) {
        if (signal?.aborted) {
          const e = new Error("Query aborted");
          e.name = "AbortError";
          throw e;
        }
        const result = await operation.fetchChunk({ maxRows: 10000 });
        if (result && result.length > 0) {
          for (const row of result) {
            if (Array.isArray(row)) {
              rows.push(row);
            } else if (typeof row === "object" && row !== null) {
              rows.push(columns.map((c) => (row as Record<string, unknown>)[c]));
            }
          }
        } else {
          hasMore = false;
        }
        if (hasMore) {
          hasMore = await operation.hasMoreRows();
        }
      }

      return { columns, rows };
    } finally {
      await operation.close().catch(() => {});
    }
  }

  return {
    async testConnection() {
      await ensureSession();
      await runSessionQuery("SELECT 1");
    },

    async listTables(): Promise<WarehouseTableInfo[]> {
      await ensureSession();

      const { rows } = await runSessionQuery("SHOW TABLES");

      const tables: WarehouseTableInfo[] = [];
      const described = new Map<string, unknown[][]>();
      for (const row of rows) {
        const tableName = String(row[0]);
        // Get column count via DESCRIBE
        try {
          const { rows: descRows } = await runSessionQuery(`DESCRIBE \`${tableName}\``);
          described.set(tableName, descRows);
          const colCount = descRows.filter(
            (r) => r[0] && String(r[0]).trim() && !String(r[0]).startsWith("#")
          ).length;

          tables.push({
            schema: dbName,
            name: tableName,
            row_count_estimate: 0,
            column_count: colCount,
          });
        } catch {
          tables.push({
            schema: dbName,
            name: tableName,
            row_count_estimate: 0,
            column_count: 0,
          });
        }
      }

      // Stash this probe's results for the introspect that follows on a cold
      // connect (perf P15): the connect flow is listTables → introspectAllTables,
      // and each used to re-issue the SAME SHOW TABLES + N DESCRIBEs — N+1
      // duplicate Thrift round-trips. listTables ALWAYS queries fresh (it is the
      // schema-change fingerprint probe, so it must never serve from a cache);
      // the stash is consumed AT MOST ONCE so a later standalone introspect can
      // never read stale results.
      lastProbe = { tables: rows.map((r) => String(r[0])), described };

      return tables;
    },

    async introspectAllTables(): Promise<WarehouseTableSchema[]> {
      await ensureSession();

      // Consume the immediately-preceding listTables probe when available
      // (cold-connect flow) instead of re-issuing SHOW TABLES + per-table
      // DESCRIBEs (perf P15). Consume-once: cleared before use.
      const probe = lastProbe;
      lastProbe = null;

      const tableNames =
        probe?.tables ?? (await runSessionQuery("SHOW TABLES")).rows.map((r) => String(r[0]));
      const schemas: WarehouseTableSchema[] = [];

      for (const tableName of tableNames) {
        try {
          const descRows =
            probe?.described.get(tableName) ??
            (await runSessionQuery(`DESCRIBE \`${tableName}\``)).rows;

          const columns: WarehouseColumnInfo[] = [];
          for (const r of descRows) {
            const colName = String(r[0] ?? "").trim();
            const colType = String(r[1] ?? "").trim();
            if (!colName || colName.startsWith("#") || !colType) continue;
            columns.push({
              name: colName,
              type: colType,
              nullable: true, // Hive doesn't indicate nullability in DESCRIBE
            });
          }

          schemas.push({
            schema: dbName,
            name: tableName,
            columns,
            row_count_estimate: 0,
          });
        } catch {
          // Skip tables we can't describe
        }
      }

      return schemas;
    },

    // Streams chunks STRAIGHT into the byte-budget CSV builder so a huge result
    // stops at MAX_CSV_SIZE_BYTES instead of buffering every row into one array
    // (the OOM backstop; postgres.ts is the reference). Abort still stops between
    // chunks rather than cancelling the HiveServer2 operation server-side.
    async executeSQL(sql: string, signal?: AbortSignal): Promise<string> {
      await ensureSession();
      if (!session) throw new Error("Hive session failed to open");
      const operation = await session.executeStatement(sql, { runAsync: false });
      try {
        const columns: string[] = [];
        const schema = await operation.getSchema();
        if (schema?.columns) {
          for (const col of schema.columns) columns.push(col.columnName);
        }
        const budget = createCsvBudget(columns, MAX_CSV_SIZE_BYTES);
        let hasMore = true;
        while (hasMore) {
          if (signal?.aborted) {
            const e = new Error("Query aborted");
            e.name = "AbortError";
            throw e;
          }
          const result = await operation.fetchChunk({ maxRows: 10000 });
          if (result && result.length > 0) {
            for (const row of result) {
              const values = Array.isArray(row)
                ? row
                : columns.map((c) => (row as Record<string, unknown>)[c]);
              if (!budget.add(values)) {
                logger.warn("Hive result hit byte budget; materialized a truncated prefix", {
                  maxBytes: MAX_CSV_SIZE_BYTES,
                  rows: budget.rows(),
                });
                return budget.finish();
              }
            }
          } else {
            hasMore = false;
          }
          if (hasMore) hasMore = await operation.hasMoreRows();
        }
        return budget.finish();
      } finally {
        await operation.close().catch(() => {});
      }
    },

    async close() {
      try {
        if (session) {
          await session.close();
          session = null;
        }
        if (connected) {
          await client.close();
          connected = false;
        }
      } catch {
        // Best effort cleanup
      }
    },
  };
}
