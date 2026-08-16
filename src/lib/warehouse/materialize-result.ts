/**
 * Store a warehouse SQL result as an analyzable source — the shared back half
 * of the warehouse path in BOTH query routes.
 *
 * Given the CSV text a connector returned: pick the Parquet path for large
 * pulls (DuckDB materialization — no Node parse, scales to millions of rows,
 * Docker runtime only) with the proven CSV path as default and fallback;
 * extract the schema; store under a fresh csvId; emit the
 * `__warehouse_csv_id` state patch so the client can use the id for
 * artifacts, notebook cell re-runs, and follow-ups; and record the
 * materialization diagnostics event.
 *
 * History: this block was duplicated in Ask and Investigate and had drifted —
 * Investigate gained the Parquet path for large pulls while Ask parsed
 * everything through Node. It lives here now so both routes share one
 * implementation (and Ask gets the Parquet path).
 */
import { randomUUID } from "crypto";
import { parseCSV } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { storeCSV } from "@/lib/csv/storage";
import { materializeCsvToParquet } from "@/lib/parquet/materialize";
import { diagEvent } from "@/lib/diagnostics/run-diagnostics";
import { WAREHOUSE_MAX_ROWS, PARQUET_MATERIALIZE_THRESHOLD } from "@/lib/constants";
import type { SandboxRuntimeId } from "@/lib/constants";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import type { WarehouseType } from "@/lib/contracts/connection-configs";
import { logger, errMessage } from "@/lib/logger";

/**
 * Cheap row estimate for a CSV string — counts newlines without a full parse,
 * so it stays fast even on a multi-hundred-MB pull. Used only to choose the
 * Parquet vs CSV path; exact accuracy isn't needed.
 */
export function countCsvRows(csv: string): number {
  let rows = 0;
  let i = csv.indexOf("\n");
  while (i !== -1) {
    rows++;
    i = csv.indexOf("\n", i + 1);
  }
  return Math.max(0, rows - 1); // minus the header line
}

export interface StoredWarehouseResult {
  csvId: string;
  schema: CSVSchema;
  /**
   * True when the pull hit the row cap — the analysis runs over a sample, so
   * aggregates/rankings are estimates and must be disclosed as such.
   */
  sampled: boolean;
  /** Host path of the materialized Parquet (docker cp → /data/input.parquet). */
  parquetFile?: string;
  /** Code-gen "Data Location" context for the Parquet read. */
  parquetContext?: string;
}

export async function storeWarehouseResult(opts: {
  csvContent: string;
  warehouseType: WarehouseType;
  sandboxRuntime: SandboxRuntimeId;
  /** Patch-stream emit — publishes the `__warehouse_csv_id` state patch. */
  emit: (line: string) => void;
  /** SQL repair count for the diagnostics event (0 = clean first try). */
  sqlRepairs?: number;
}): Promise<StoredWarehouseResult> {
  const newCsvId = randomUUID();
  const approxRows = countCsvRows(opts.csvContent);
  let schema: CSVSchema | undefined;
  let parquetFile: string | undefined;
  let parquetContext: string | undefined;

  // Large pull → Parquet + DuckDB (no Node parse, scales to millions).
  // Best-effort: any failure falls back to the proven CSV path below.
  if (approxRows >= PARQUET_MATERIALIZE_THRESHOLD && opts.sandboxRuntime === "docker") {
    try {
      const mat = await materializeCsvToParquet(
        opts.csvContent,
        newCsvId,
        "warehouse_query_result",
        opts.sandboxRuntime
      );
      schema = mat.schema;
      schema.source_type = "warehouse";
      schema.warehouse_type = opts.warehouseType;
      parquetFile = mat.parquetPath;
      const cappedSample = schema.row_count >= WAREHOUSE_MAX_ROWS;
      parquetContext =
        `The materialized dataset is a Parquet file at /data/input.parquet (${schema.row_count.toLocaleString()} rows).\n` +
        `Read it with DuckDB: duckdb.sql("SELECT * FROM read_parquet('/data/input.parquet')").df().\n` +
        `This is a large dataset — aggregate/filter in DuckDB SQL and convert only the small result to pandas; never SELECT * without a LIMIT or aggregation. Do NOT read /data/input.csv.` +
        (cappedSample
          ? `\nIMPORTANT — this is a CAPPED SAMPLE of ${schema.row_count.toLocaleString()} rows; the source has MORE. Do NOT present absolute totals or counts as findings (a "total" here just equals the sample size, ${schema.row_count.toLocaleString()}, and is misleading). Express results as RATES, proportions, percentages, or per-entity averages instead.`
          : "");
      logger.info("Warehouse result materialized to Parquet", {
        csvId: newCsvId,
        rows: schema.row_count,
      });
    } catch (err) {
      logger.warn("Parquet materialization failed, falling back to CSV", {
        error: errMessage(err),
        approxRows,
      });
    }
  }

  // CSV path (default for small pulls, and the fallback if Parquet failed).
  if (!schema) {
    const parsed = parseCSV(opts.csvContent);
    schema = extractSchema(parsed, newCsvId, "warehouse_query_result");
    schema.source_type = "warehouse";
    schema.warehouse_type = opts.warehouseType;
  }

  await storeCSV(newCsvId, opts.csvContent, schema);
  // Hitting the cap means the source had more rows than we pulled — the
  // analysis is over a sample, not the full data.
  const sampled = schema.row_count >= WAREHOUSE_MAX_ROWS;

  diagEvent("materialization", {
    rows: schema.row_count,
    columns: schema.columns.length,
    sampled,
    parquet: !!parquetFile,
    sqlRepairs: opts.sqlRepairs ?? 0,
  });
  logger.info("Warehouse result stored", {
    csvId: newCsvId,
    columns: schema.columns.length,
    rows: schema.row_count,
    parquet: !!parquetFile,
    sampled,
  });

  // Emit the generated csvId so the client can use it for artifacts,
  // notebook cell re-runs, and follow-ups.
  opts.emit(
    JSON.stringify({ op: "add", path: "/state/__warehouse_csv_id", value: newCsvId }) + "\n"
  );

  return { csvId: newCsvId, schema, sampled, parquetFile, parquetContext };
}
