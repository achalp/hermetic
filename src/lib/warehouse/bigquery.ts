import { BigQuery } from "@google-cloud/bigquery";
import type {
  BigQueryConnectionConfig,
  WarehouseTableInfo,
  WarehouseTableSchema,
  WarehouseColumnInfo,
} from "@/lib/types";
import type { WarehouseConnector } from "./connector";

export function createBigQueryConnector(config: BigQueryConnectionConfig): WarehouseConnector {
  const credentials = JSON.parse(config.credentialsJson);
  const bq = new BigQuery({
    projectId: config.projectId,
    credentials,
  });
  const dataset = config.dataset;
  const project = config.projectId;

  return {
    async testConnection() {
      await bq.dataset(dataset).get();
    },

    async listTables(): Promise<WarehouseTableInfo[]> {
      // Use getTables API as fallback-safe approach
      const [tables] = await bq.dataset(dataset).getTables();
      const results: WarehouseTableInfo[] = [];
      for (const table of tables ?? []) {
        const [meta] = await table.getMetadata();
        results.push({
          schema: dataset,
          name: table.id ?? "",
          row_count_estimate: Number(meta.numRows ?? 0),
          column_count: meta.schema?.fields?.length ?? 0,
        });
      }
      return results;
    },

    async introspectAllTables(): Promise<WarehouseTableSchema[]> {
      // Get all columns across all tables
      const [colRows] = await bq.query({
        query: `SELECT table_name, column_name, data_type, is_nullable
                FROM \`${project}.${dataset}.INFORMATION_SCHEMA.COLUMNS\`
                ORDER BY table_name, ordinal_position`,
      });

      // Get row counts
      const [tables] = await bq.dataset(dataset).getTables();
      const rowCounts = new Map<string, number>();
      for (const table of tables ?? []) {
        const [meta] = await table.getMetadata();
        rowCounts.set(table.id ?? "", Number(meta.numRows ?? 0));
      }

      // BigQuery doesn't have traditional PKs/FKs, but we can check for them
      // in INFORMATION_SCHEMA.TABLE_CONSTRAINTS (available in some projects)
      // For now, skip PK/FK introspection for BigQuery

      // Group columns by table
      const tableColumns = new Map<string, WarehouseColumnInfo[]>();
      for (const r of colRows) {
        const tableName = String(r.table_name);
        const existing = tableColumns.get(tableName) ?? [];
        existing.push({
          name: String(r.column_name),
          type: String(r.data_type),
          nullable: String(r.is_nullable) === "YES",
        });
        tableColumns.set(tableName, existing);
      }

      const schemas: WarehouseTableSchema[] = [];
      for (const [tableName, columns] of tableColumns) {
        schemas.push({
          schema: dataset,
          name: tableName,
          columns,
          row_count_estimate: rowCounts.get(tableName) ?? 0,
        });
      }

      return schemas;
    },

    async executeSQL(sql: string): Promise<string> {
      const [rows] = await bq.query({ query: sql });

      if (!rows || rows.length === 0) return "";

      const headers = Object.keys(rows[0]);
      const lines = [headers.join(",")];
      for (const row of rows) {
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
      // BigQuery client doesn't maintain persistent connections
    },
  };
}
