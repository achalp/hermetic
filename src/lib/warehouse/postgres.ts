import pg from "pg";
import type {
  PostgresConnectionConfig,
  WarehouseTableInfo,
  WarehouseTableSchema,
  WarehouseColumnInfo,
} from "@/lib/types";
import type { WarehouseConnector } from "./connector";

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Convert a value to a CSV-safe string, handling nulls properly */
function csvValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
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
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 10_000,
    max: 3, // small pool — this is an analytical tool, not a web server
    idleTimeoutMillis: 60_000,
    // Server-side statement timeout: kills long-running queries on the PG server itself.
    // This is critical — the Node.js query_timeout only cancels the client-side wait,
    // but the query keeps running on the server. statement_timeout kills it server-side.
    options: "-c statement_timeout=120000",
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

    async executeSQL(sql: string): Promise<string> {
      const res = await pool.query(sql);

      if (!res.rows.length) return "";

      const headers = res.fields.map((f) => f.name);
      const lines = [headers.map(csvValue).join(",")];
      for (const row of res.rows) {
        lines.push(headers.map((h) => csvValue(row[h])).join(","));
      }
      return lines.join("\n") + "\n";
    },

    async close() {
      await pool.end().catch(() => {});
    },
  };
}
