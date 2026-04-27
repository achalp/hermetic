/**
 * Databricks SQL warehouse connector.
 *
 * Uses the official `@databricks/sql` driver. v1 supports Personal Access
 * Token auth only (`authType: "access-token"`). OAuth deferred.
 *
 * Schema introspection uses Unity Catalog's `system.information_schema`
 * when available, falling back to plain `INFORMATION_SCHEMA`. Three-part
 * names (`catalog.schema.table`) are required for Unity Catalog.
 */

import { DBSQLClient } from "@databricks/sql";
import type {
  DatabricksConnectionConfig,
  WarehouseTableInfo,
  WarehouseTableSchema,
  WarehouseColumnInfo,
} from "@/lib/types";
import type { WarehouseConnector } from "./connector";

type Row = Record<string, unknown>;

/** Convert a value to a CSV-safe string, handling nulls properly. */
function csvValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s: string;
  if (v instanceof Date) {
    s = v.toISOString();
  } else if (typeof v === "object") {
    s = JSON.stringify(v);
  } else {
    s = String(v);
  }
  return s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

export function createDatabricksConnector(config: DatabricksConnectionConfig): WarehouseConnector {
  const catalog = config.catalog;
  const schemaName = config.schema ?? "default";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = new DBSQLClient() as any;

  // Connect lazily on first use; keeps the constructor non-async.
  let connectPromise: Promise<unknown> | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let session: any | undefined;

  async function ensureSession() {
    if (!connectPromise) {
      connectPromise = client.connect({
        host: config.serverHostname,
        path: config.httpPath,
        token: config.token,
      });
    }
    await connectPromise;
    if (!session) {
      session = await client.openSession({
        initialCatalog: catalog,
        initialSchema: schemaName,
      });
    }
    return session;
  }

  async function executeQuery<T = Row>(sql: string): Promise<T[]> {
    const sess = await ensureSession();
    const op = await sess.executeStatement(sql, { runAsync: false });
    try {
      const rows = (await op.fetchAll()) as unknown as T[];
      return rows;
    } finally {
      await op.close().catch(() => {});
    }
  }

  return {
    async testConnection() {
      await executeQuery("SELECT 1");
    },

    async listTables(): Promise<WarehouseTableInfo[]> {
      // Unity Catalog: information_schema lives under the catalog
      const rows = await executeQuery<{
        table_name?: string;
        column_count?: number | string | null;
      }>(
        `SELECT t.table_name AS table_name,
                COUNT(c.column_name) AS column_count
         FROM \`${catalog}\`.information_schema.tables t
         LEFT JOIN \`${catalog}\`.information_schema.columns c
           ON c.table_schema = t.table_schema AND c.table_name = t.table_name
         WHERE t.table_schema = '${schemaName}' AND t.table_type = 'MANAGED'
         GROUP BY t.table_name
         ORDER BY t.table_name`
      );
      return rows.map((r) => ({
        schema: `${catalog}.${schemaName}`,
        name: String(r.table_name ?? ""),
        // Databricks information_schema doesn't expose row count cheaply;
        // a separate stats query would be needed. 0 = "unknown" in this app.
        row_count_estimate: 0,
        column_count: Number(r.column_count ?? 0),
      }));
    },

    async introspectAllTables(): Promise<WarehouseTableSchema[]> {
      const colRows = await executeQuery<{
        table_name?: string;
        column_name?: string;
        data_type?: string;
        is_nullable?: string;
      }>(
        `SELECT table_name AS table_name,
                column_name AS column_name,
                data_type AS data_type,
                is_nullable AS is_nullable
         FROM \`${catalog}\`.information_schema.columns
         WHERE table_schema = '${schemaName}'
         ORDER BY table_name, ordinal_position`
      );

      // Databricks does not enforce PK/FK constraints on managed tables in
      // information_schema in the same way as Postgres. We populate an empty
      // map and rely on the `inferRelationships` post-processor for FK hints.
      const tableColumns = new Map<string, WarehouseColumnInfo[]>();
      for (const r of colRows) {
        const tname = String(r.table_name ?? "");
        const list = tableColumns.get(tname) ?? [];
        list.push({
          name: String(r.column_name ?? ""),
          type: String(r.data_type ?? ""),
          nullable: String(r.is_nullable ?? "YES").toUpperCase() === "YES",
        });
        tableColumns.set(tname, list);
      }

      const schemas: WarehouseTableSchema[] = [];
      for (const [tableName, columns] of tableColumns) {
        schemas.push({
          schema: `${catalog}.${schemaName}`,
          name: tableName,
          columns,
          row_count_estimate: 0,
        });
      }
      return schemas;
    },

    async executeSQL(sql: string): Promise<string> {
      const rows = await executeQuery<Row>(sql);
      if (rows.length === 0) return "";

      // Databricks returns nested objects/arrays as JS values; use the first
      // row's keys for the header (matches existing connector behavior).
      const headers = Object.keys(rows[0]);
      const lines = [headers.map(csvValue).join(",")];
      for (const row of rows) {
        lines.push(headers.map((h) => csvValue(row[h])).join(","));
      }
      return lines.join("\n") + "\n";
    },

    async close() {
      try {
        if (session) await session.close().catch(() => {});
      } finally {
        await client.close().catch(() => {});
      }
    },
  };
}
