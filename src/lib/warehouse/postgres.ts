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

export function createPostgresConnector(config: PostgresConnectionConfig): WarehouseConnector {
  const client = new pg.Client({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 10_000,
    query_timeout: 60_000,
  });

  let connected = false;
  const schemaName = config.schema ?? "public";

  async function ensureConnected() {
    if (!connected) {
      await client.connect();
      connected = true;
    }
  }

  return {
    async testConnection() {
      await ensureConnected();
      await client.query("SELECT 1");
    },

    async listTables(): Promise<WarehouseTableInfo[]> {
      await ensureConnected();
      const res = await client.query(
        `SELECT c.relname AS name,
                c.reltuples::bigint AS row_count,
                count(a.attname)::int AS column_count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
         WHERE n.nspname = $1
           AND c.relkind IN ('r', 'v', 'm')
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
      await ensureConnected();

      // Get all columns for all tables in one query
      const colRes = await client.query(
        `SELECT table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = $1
         ORDER BY table_name, ordinal_position`,
        [schemaName]
      );

      // Get row counts
      const countRes = await client.query(
        `SELECT c.relname AS name, c.reltuples::bigint AS row_count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('r', 'v', 'm')`,
        [schemaName]
      );
      const rowCounts = new Map(
        countRes.rows.map((r) => [r.name, Math.max(0, Number(r.row_count))])
      );

      // Get primary keys
      const pkRes = await client.query(
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
      const fkRes = await client.query(
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
      await ensureConnected();
      const res = await client.query(sql);

      if (!res.rows.length) return "";

      const headers = res.fields.map((f) => f.name);
      const lines = [headers.join(",")];
      for (const row of res.rows) {
        const vals = headers.map((h) => {
          const v = String(row[h] ?? "");
          return v.includes(",") || v.includes('"') || v.includes("\n")
            ? `"${v.replace(/"/g, '""')}"`
            : v;
        });
        lines.push(vals.join(","));
      }
      return lines.join("\n") + "\n";
    },

    async close() {
      if (connected) {
        await client.end().catch(() => {});
        connected = false;
      }
    },
  };
}
