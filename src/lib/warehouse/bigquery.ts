import { BigQuery } from "@google-cloud/bigquery";
import type {
  BigQueryConnectionConfig,
  WarehouseTableInfo,
  WarehouseTableSchema,
  WarehouseColumnInfo,
} from "@/lib/types";
import type { WarehouseConnector } from "./connector";

export function createBigQueryConnector(config: BigQueryConnectionConfig): WarehouseConnector {
  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(config.credentialsJson);
  } catch {
    throw new Error(
      "Invalid credentials JSON. Paste the full service account key JSON (starts with {), or provide a file path."
    );
  }

  // The projectId for auth (billing) comes from the service account or user input.
  // The dataset may reference a different project (e.g., bigquery-public-data).
  // Parse "project.dataset" format if provided.
  let dataProject = config.projectId;
  let datasetName = config.dataset;

  if (config.dataset.includes(".")) {
    const parts = config.dataset.split(".");
    dataProject = parts[0];
    datasetName = parts[1];
  }

  const bq = new BigQuery({
    projectId: config.projectId,
    credentials,
  });

  return {
    async testConnection() {
      // Use a lightweight query to test credentials + access
      try {
        await bq.dataset(datasetName, { projectId: dataProject }).get();
      } catch (err: unknown) {
        // Provide actionable error messages
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Not found")) {
          throw new Error(
            `Dataset "${datasetName}" not found in project "${dataProject}". ` +
              `For public datasets, use format: bigquery-public-data.dataset_name`
          );
        }
        if (msg.includes("403") || msg.includes("Permission")) {
          throw new Error(
            `Permission denied. Ensure the service account has "BigQuery Job User" and "BigQuery Data Viewer" roles.`
          );
        }
        throw new Error(`BigQuery connection test failed: ${msg}`);
      }
    },

    async listTables(): Promise<WarehouseTableInfo[]> {
      const [tables] = await bq.dataset(datasetName, { projectId: dataProject }).getTables();
      const results: WarehouseTableInfo[] = [];
      for (const table of tables ?? []) {
        const [meta] = await table.getMetadata();
        results.push({
          schema: `${dataProject}.${datasetName}`,
          name: table.id ?? "",
          row_count_estimate: Number(meta.numRows ?? 0),
          column_count: meta.schema?.fields?.length ?? 0,
        });
      }
      return results;
    },

    async introspectAllTables(): Promise<WarehouseTableSchema[]> {
      const fullDataset = `\`${dataProject}.${datasetName}\``;

      // Get all columns across all tables
      const [colRows] = await bq.query({
        query: `SELECT table_name, column_name, data_type, is_nullable
                FROM ${fullDataset}.INFORMATION_SCHEMA.COLUMNS
                ORDER BY table_name, ordinal_position`,
      });

      // Get row counts
      const [tables] = await bq.dataset(datasetName, { projectId: dataProject }).getTables();
      const rowCounts = new Map<string, number>();
      for (const table of tables ?? []) {
        const [meta] = await table.getMetadata();
        rowCounts.set(table.id ?? "", Number(meta.numRows ?? 0));
      }

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
          schema: `${dataProject}.${datasetName}`,
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
