/**
 * Host-side Parquet schema extraction — the no-Docker half of the ingest wall
 * (build log D24/D25).
 *
 * The Docker path (`schema-extractor.ts`) runs a Python/DuckDB script in an
 * ephemeral container. Nothing about profiling a LOCAL parquet file actually
 * needs a container: `host-duckdb.ts` already runs the same DuckDB engine
 * in-process against the real filesystem. This module does exactly that work
 * without one, so the built-in (wasm) runtime can CONNECT a local parquet source.
 *
 * ── How it stays ONE profiler, not two ──
 * The tempting shape — re-implement `SHARED_STATS_TAIL`'s ~400 lines of per-column
 * SQL in TypeScript — would leave two profilers that drift apart silently, and
 * only one of them testable without Docker. Instead we split the work by who is
 * actually authoritative:
 *
 *   - DuckDB answers what only DuckDB knows: the column TYPES (`DESCRIBE`) and the
 *     true ROW COUNT (parquet footers for a folder, `count(*)` for a file).
 *   - A bounded row sample is written to CSV and handed to `extractSchema` — the
 *     same profiler the CSV ingest path has always used — with the DuckDB types
 *     passed in as `dtype` overrides so nothing is re-guessed from text.
 *
 * So the stats logic has one implementation, and the CSV round-trip cannot
 * mistype a column: `BIGINT` stays a number even if its sampled values happen to
 * all look like dates.
 *
 * ── Honest differences from the Docker path ──
 * The container profiles a 500k-row DuckDB sample with SQL aggregates; this
 * profiles {@link HOST_PROFILE_ROWS} rows in JavaScript, because the TS profiler
 * walks every value several times per column. `row_count` is exact either way —
 * it is the per-column stats that come from a smaller sample. That is a real
 * difference in stats precision, not in correctness, and it is why this is not
 * simply swapped in for Docker.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CSVSchema, CSVColumn } from "@/lib/contracts/data-schema";
import { parseCSV } from "@/lib/csv/parser";
import { extractSchema, type DtypeOverrides } from "@/lib/csv/schema";
import { hostQueryRows, hostExec } from "@/lib/sandbox/wasm/host-duckdb";
import { sqlLit } from "@/lib/sandbox/wasm/sql-lit";
import { logger } from "@/lib/logger";

/**
 * Rows sampled for per-column stats. Bounded because the profiler is JavaScript
 * walking strings, not SQL aggregates — see the header note. Large enough that a
 * categorical column's top values and a numeric column's distribution are
 * meaningful; small enough that connecting a source stays interactive.
 */
export const HOST_PROFILE_ROWS = 50_000;

/**
 * Map a DuckDB type to a CSVSchema dtype.
 *
 * Nested/complex types (STRUCT, LIST, MAP, UNION, GEOMETRY) collapse to "string":
 * they arrive in the CSV sample as their text serialization, and "string" is what
 * the CSVSchema contract actually admits. The Docker script emits "complex" for
 * these, which is NOT in the dtype union — matching that here would put an
 * out-of-contract value into the schema, so we deliberately do not.
 *
 * Order matters: the nested check runs FIRST, so `STRUCT(confidence DOUBLE)[]` is
 * not read as a number by substring match (the same trap the Python map hits).
 */
export function mapDuckDbType(duckdbType: string): CSVColumn["dtype"] {
  const t = duckdbType.toUpperCase();
  const has = (...keys: string[]) => keys.some((k) => t.includes(k));
  if (has("STRUCT", "MAP", "UNION", "LIST", "ARRAY", "[]", "GEOMETRY")) return "string";
  if (has("INT", "BIGINT", "SMALLINT", "TINYINT", "FLOAT", "DOUBLE", "DECIMAL", "NUMERIC", "REAL"))
    return "number";
  if (has("DATE", "TIMESTAMP", "TIME")) return "date";
  if (has("BOOL")) return "boolean";
  return "string";
}

/**
 * Coerce a DuckDB scalar to a row count. Counts arrive as BIGINT/HUGEINT, which
 * the Arrow bridge hands back as a bigint, a plain number, or a quoted decimal
 * string depending on the aggregate — so normalize all three rather than trusting
 * one shape. Anything unreadable yields 0, never NaN (NaN would serialize into
 * the schema and poison the prompt).
 */
export function toRowCount(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const n = Number(value.replace(/"/g, "").trim());
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  return 0;
}

/** The `read_parquet(...)` expression for a local file or folder of parquet. */
export function hostReadExpr(
  localPath: string,
  isFolder: boolean,
  isHivePartitioned?: boolean
): string {
  const target = isFolder ? `${localPath.replace(/\/+$/, "")}/**/*.parquet` : localPath;
  const hive = isFolder && isHivePartitioned ? ", hive_partitioning=true" : "";
  return `read_parquet('${sqlLit(target)}'${hive})`;
}

/**
 * Profile a local Parquet file (or folder) into a CSVSchema, entirely on the host.
 * `localPath` is a real filesystem path the user already chose; nothing here
 * touches the network.
 */
export async function extractParquetSchemaHost(args: {
  localPath: string;
  csvId: string;
  filename: string;
  isFolder: boolean;
  isHivePartitioned?: boolean;
}): Promise<CSVSchema> {
  const { localPath, csvId, filename, isFolder, isHivePartitioned } = args;
  const readExpr = hostReadExpr(localPath, isFolder, isHivePartitioned);

  // Types first: a DESCRIBE with LIMIT 0 reads footers only, so an unreadable or
  // empty folder fails HERE, before we spend a scan on it.
  const described = await hostQueryRows(`DESCRIBE SELECT * FROM ${readExpr} LIMIT 0`);
  if (described.length === 0) {
    throw new Error(`No readable Parquet columns found at ${filename}.`);
  }
  const dtypes: Record<string, CSVColumn["dtype"]> = {};
  for (const row of described) {
    const name = String(row.column_name ?? "");
    if (name) dtypes[name] = mapDuckDbType(String(row.column_type ?? ""));
  }

  const rowCount = await countRows(readExpr, localPath, isFolder);

  // A bounded PREFIX, not a random sample: `USING SAMPLE` would scan every row
  // group to draw from the whole dataset, which is the cost this path exists to
  // avoid. The remote script makes the same trade for the same reason.
  const dir = await mkdtemp(join(tmpdir(), "hermetic-pqprofile-"));
  const samplePath = join(dir, "sample.csv");
  try {
    await hostExec(
      `COPY (SELECT * FROM ${readExpr} LIMIT ${HOST_PROFILE_ROWS}) ` +
        `TO '${sqlLit(samplePath)}' (HEADER, FORMAT CSV)`
    );
    const parsed = parseCSV(await readFile(samplePath, "utf8"));
    const schema = extractSchema(parsed, csvId, filename, dtypes as DtypeOverrides);

    logger.info("Parquet schema extracted on host (no Docker)", {
      csvId,
      filename,
      rowCount,
      columnCount: schema.columns.length,
      profiledRows: parsed.rowCount,
      isFolder,
    });

    return {
      ...schema,
      // The profiler only saw the sample; the dataset's real size is what the
      // prompt (and every downstream row-cap decision) must see.
      row_count: rowCount,
      source_type: "file",
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Exact row count. For a folder we sum `num_rows` out of the parquet footers —
 * metadata only, no data pages — and fall back to a real count if the metadata
 * function is unavailable for these files.
 */
async function countRows(readExpr: string, localPath: string, isFolder: boolean): Promise<number> {
  if (isFolder) {
    const glob = `${localPath.replace(/\/+$/, "")}/**/*.parquet`;
    try {
      const rows = await hostQueryRows(
        `SELECT SUM(num_rows) AS n FROM parquet_file_metadata('${sqlLit(glob)}')`
      );
      const n = toRowCount(rows[0]?.n);
      if (n > 0) return n;
    } catch (err) {
      logger.debug("parquet_file_metadata unavailable; counting rows directly", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const rows = await hostQueryRows(`SELECT COUNT(*) AS n FROM ${readExpr}`);
  return toRowCount(rows[0]?.n);
}
