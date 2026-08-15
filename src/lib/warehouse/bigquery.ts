import { BigQuery } from "@google-cloud/bigquery";
import type { BigQueryConnectionConfig } from "@/lib/contracts/connection-configs";
import type {
  WarehouseTableInfo,
  WarehouseTableSchema,
  WarehouseColumnInfo,
} from "@/lib/contracts/warehouse-schema";
import type { WarehouseConnector, ScanWindow } from "./connector";
import { extractDateEpoch, parsePartitionId, sizeScanWindow } from "./scan-window";
import { csvValue } from "@/lib/csv/csv-util";
import { MAX_CSV_SIZE_BYTES } from "@/lib/constants";
import { logger } from "@/lib/logger";

/** Rows per getQueryResults page — paginate instead of buffering all rows. */
const BQ_PAGE_ROWS = 10_000;

function abortError(): Error {
  const e = new Error("Query aborted");
  e.name = "AbortError";
  return e;
}

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

  // No session-level read-only mode in the BigQuery API (write control is IAM
  // roles; grant the service account read-only roles) — assertReadOnlySql is
  // the only write gate on this connector.
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

    /**
     * Size a recent scan window for `table` so a bounded pull stays under
     * BigQuery's read limit — tiered, cheapest-first:
     *
     *   Tier 1 (no data scan): INFORMATION_SCHEMA.PARTITIONS gives the partition
     *     values AND per-partition row counts as METADATA. We get the date range
     *     and density for free, on the column that actually prunes the scan.
     *   Tier 2 (one-column scan): for NON-partitioned tables (which are usually
     *     modest, so this is cheap), MIN/MAX/COUNT on the requested date column.
     *
     * Returns null when we can't size a window (caller falls back to the LLM
     * choosing one). Window dates are day-granular `YYYY-MM-DD` — enough to bound
     * a scan; the SQL-gen wraps them with DATE()/TIMESTAMP() per the dialect.
     */
    async getScanSafeWindow(table: string, dateColumn: string, budgetRows: number) {
      const bare = table.includes(".") ? table.split(".").pop()! : table;
      // Identifier guards — both are interpolated into SQL below.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(bare)) return null;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dateColumn)) return null;
      const ds = `\`${dataProject}.${datasetName}\``;
      const fq = `\`${dataProject}.${datasetName}.${bare}\``;
      const DAY_MS = 86_400_000;

      const withColumn = (
        w: ReturnType<typeof sizeScanWindow>,
        column: string
      ): ScanWindow | null => (w ? { ...w, column } : null);

      // ── Tier 1: partition metadata (no data scan) ──
      try {
        const [partRows] = await bq.query({
          query: `SELECT partition_id, total_rows
                  FROM ${ds}.INFORMATION_SCHEMA.PARTITIONS
                  WHERE table_name = '${bare}'`,
        });
        const real = (partRows ?? []).filter((r) => {
          const pid = r.partition_id;
          return pid && pid !== "__NULL__" && pid !== "__UNPARTITIONED__";
        });
        if (real.length > 0) {
          let minMs = Infinity;
          let maxMs = -Infinity;
          let total = 0;
          let dateLike = true;
          for (const r of real) {
            const ms = parsePartitionId(String(r.partition_id));
            if (ms == null) {
              dateLike = false; // integer-range partitioning → not a time window
              break;
            }
            minMs = Math.min(minMs, ms);
            maxMs = Math.max(maxMs, ms);
            total += Number(r.total_rows ?? 0);
          }
          if (dateLike && total > 0) {
            // The partition_id is the partition's START; extend the end by a day
            // so the window covers the final (newest) partition inclusively.
            const [colRows] = await bq.query({
              query: `SELECT column_name FROM ${ds}.INFORMATION_SCHEMA.COLUMNS
                      WHERE table_name = '${bare}' AND is_partitioning_column = 'YES'
                      LIMIT 1`,
            });
            // No declared partitioning column ⇒ ingestion-time partitioning.
            const partCol = colRows?.[0]?.column_name
              ? String(colRows[0].column_name)
              : "_PARTITIONDATE";
            const win = withColumn(
              sizeScanWindow(minMs, maxMs + DAY_MS, total, budgetRows),
              partCol
            );
            if (win) return win;
          }
        }
      } catch {
        // INFORMATION_SCHEMA unavailable / denied → fall through to Tier 2.
      }

      // ── Tier 2: MIN/MAX/COUNT on the requested date column (scans one column) ──
      try {
        const [rows] = await bq.query({
          query: `SELECT CAST(MIN(\`${dateColumn}\`) AS STRING) AS min_d,
                         CAST(MAX(\`${dateColumn}\`) AS STRING) AS max_d,
                         COUNT(*) AS total
                  FROM ${fq}`,
        });
        const r = rows?.[0];
        const minMs = extractDateEpoch(r?.min_d);
        const maxMs = extractDateEpoch(r?.max_d);
        const total = Number(r?.total ?? 0);
        if (minMs == null || maxMs == null) return null;
        return withColumn(sizeScanWindow(minMs, maxMs + DAY_MS, total, budgetRows), dateColumn);
      } catch {
        return null;
      }
    },

    async executeSQL(sql: string, signal?: AbortSignal): Promise<string> {
      if (signal?.aborted) throw abortError();

      // No jobTimeoutMs: we never self-kill a running analysis (a legitimately
      // long query is allowed to take long) — the user's Stop button and
      // BigQuery's own 6-hour hard limit are the ceilings. (A prior 20-min cap
      // was itself a self-kill; it's superseded by stop-on-demand.)
      //
      // createQueryJob (NOT bq.query) so we hold a JOB handle: on Stop we call
      // job.cancel(), which STOPS the server-side job and its billing. Previously
      // bq.query gave no handle, so Stop aborted only the client request while the
      // job kept running (and billing) up to BigQuery's 6h hard limit — the
      // acknowledged TODO, now fixed.
      const [job] = await bq.createQueryJob({ query: sql });
      const onAbort = () => void job.cancel().catch(() => {});
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        // An abort that landed WHILE createQueryJob was in flight (before the
        // listener existed) still cancels the now-known job.
        if (signal?.aborted) {
          void job.cancel().catch(() => {});
          throw abortError();
        }

        let headers: string[] | null = null;
        const lines: string[] = [];
        let bytes = 0;
        let dataRows = 0;
        let truncated = false;

        // Paginate the result set instead of buffering every row in one array.
        // getQueryResults with autoPaginate:false returns the next page's options
        // (carrying pageToken) as the second tuple element; null when exhausted.
        let pageToken: string | undefined;
        do {
          if (signal?.aborted) throw abortError();
          const page = await job.getQueryResults({
            maxResults: BQ_PAGE_ROWS,
            pageToken,
            autoPaginate: false,
          });
          const rows = (page[0] ?? []) as Record<string, unknown>[];
          pageToken = (page[1] as { pageToken?: string } | null)?.pageToken;

          for (const row of rows) {
            if (headers === null) {
              // Canonical serializer via csv-util — a prior local copy joined
              // headers UNQUOTED, corrupting comma-bearing column names.
              headers = Object.keys(row);
              const headerLine = headers.map(csvValue).join(",");
              lines.push(headerLine);
              bytes += Buffer.byteLength(headerLine) + 1;
            }
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
        } while (pageToken);

        if (truncated) {
          logger.warn("BigQuery result hit byte budget; materialized a truncated prefix", {
            maxBytes: MAX_CSV_SIZE_BYTES,
            rows: dataRows,
          });
        }

        if (dataRows === 0) return "";
        return lines.join("\n") + "\n";
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },

    async close() {
      // BigQuery client doesn't maintain persistent connections
    },
  };
}
