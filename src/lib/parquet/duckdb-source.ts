/**
 * Single source of truth for "how does the sandbox read this Parquet/CSV dataset
 * via DuckDB, and what do we tell code-gen about it". Both the Ask route and the
 * Investigate route used to hand-build near-identical `read_parquet(...)`
 * expressions and "Data Location" prose; that lived in two places and drifted.
 * It lives here now, so a change (or a new source kind like remote cloud Parquet)
 * lands once.
 */
import { basename, dirname } from "node:path";
import { LOCAL_MOUNT_PATH } from "@/lib/constants";
import type { StoredCSV } from "@/lib/types";

/** Rows above which we must push aggregation into DuckDB before `.df()`. */
const LARGE_ROWS = 1_000_000;

/**
 * DuckDB prelude to enable reading cloud files (httpfs → s3://, https://) and
 * spatial/geo ops (spatial). The sandbox image pre-bundles both, so LOAD is
 * offline + instant; INSTALL stays as a fallback for a runtime that didn't
 * pre-bundle (it's a no-op when the extension is already present).
 */
export const DUCKDB_CLOUD_PRELUDE = "INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;";

/**
 * Python that runs the prelude on a DuckDB connection before any remote read.
 * `con` is the DuckDB connection variable name in the generated script.
 */
export function duckdbCloudPreludePy(con = "duckdb"): string {
  return `${con}.sql("${DUCKDB_CLOUD_PRELUDE}")`;
}

/** A DuckDB `read_parquet(...)` expression for a path OR a remote URL (s3://,
 *  https://). Hive-partitioned folders add the flag so partition columns surface. */
export function parquetReadExpr(pathOrUrl: string, hivePartitioned = false): string {
  return `read_parquet('${pathOrUrl}'${hivePartitioned ? ", hive_partitioning=true" : ""})`;
}

/** The "reduce in SQL, never SELECT * unaggregated" guidance appended for a large
 *  dataset — shared so the wording is identical everywhere. */
function largeDataNote(rowCount: number): string {
  return (
    `CRITICAL: This is a large dataset (${rowCount.toLocaleString()} rows). You MUST use DuckDB SQL ` +
    `with WHERE, GROUP BY, or LIMIT to reduce data BEFORE calling .df(). NEVER SELECT * without a LIMIT ` +
    `or aggregation. Aggregate in SQL, convert only the small result to pandas. Keep total queries to 3 ` +
    `or fewer — combine aggregations into a single query when possible.\n`
  );
}

/** Code-gen "Data Location" context for a FOLDER of Parquet shards (read via a view). */
export function parquetFolderContext(readExpr: string, rowCount: number, hive: boolean): string {
  return (
    `This is a ${hive ? "Hive-partitioned " : ""}folder of Parquet files.\n` +
    `Total rows: ${rowCount.toLocaleString()}.\n` +
    `FIRST, create a DuckDB view ONCE at the top of the script:\n` +
    `  duckdb.sql("CREATE OR REPLACE VIEW data AS SELECT * FROM ${readExpr}")\n` +
    `Then query the view. If the question targets a subset (e.g. specific users, date range), ` +
    `materialize the filtered subset into a temp table FIRST for speed:\n` +
    `  duckdb.sql("CREATE TEMP TABLE filtered AS SELECT * FROM data WHERE ...")\n` +
    `  Then run all subsequent queries against 'filtered' instead of 'data'.\n` +
    (hive
      ? `Partition columns (e.g. year, month) are automatically available as columns via Hive partitioning. USE them in WHERE clauses to filter efficiently.\n`
      : "") +
    (rowCount > LARGE_ROWS ? largeDataNote(rowCount) : "") +
    `Do NOT read from /data/input.csv — the data is in Parquet format.\n` +
    `Do NOT use pd.read_parquet() — use duckdb.sql() for this dataset.`
  );
}

/** Code-gen "Data Location" context for a SINGLE Parquet file. */
export function parquetFileContext(readExpr: string, where: string, rowCount: number): string {
  return (
    `This is a Parquet file at ${where} (${rowCount.toLocaleString()} rows).\n` +
    `Read with: duckdb.sql("SELECT * FROM ${readExpr}").df()\n` +
    (rowCount > LARGE_ROWS ? largeDataNote(rowCount) : "") +
    `Do NOT read from /data/input.csv — the data is in Parquet at ${where}.`
  );
}

/** Code-gen "Data Location" context for a single mounted CSV/other file. */
function csvFileContext(fname: string): string {
  const p = `${LOCAL_MOUNT_PATH}/${fname}`;
  return (
    `The data file is mounted at ${p}.\n` +
    `Read with: pd.read_csv("${p}")\n` +
    `Do NOT read from /data/input.csv — the data is at ${p}.`
  );
}

/**
 * Resolve a browsed LOCAL-file source into (a) the host path to bind-mount and
 * (b) the code-gen "Data Location" context. Shared by both query routes. Returns
 * empty for a non-local (upload/warehouse) source.
 *
 * Mount strategy (unchanged): a folder mounts itself; a single file mounts its
 * parent directory (so the file lands at /data/local/<name>).
 */
export function resolveLocalSource(stored: StoredCSV): {
  localMountPath?: string;
  localFileContext?: string;
} {
  if (stored.localFolderPath) {
    const readExpr = parquetReadExpr(
      `${LOCAL_MOUNT_PATH}/**/*.parquet`,
      !!stored.isHivePartitioned
    );
    return {
      localMountPath: stored.localFolderPath,
      localFileContext: parquetFolderContext(
        readExpr,
        stored.schema.row_count,
        !!stored.isHivePartitioned
      ),
    };
  }
  if (stored.localPath) {
    const fname = basename(stored.localPath);
    const where = `${LOCAL_MOUNT_PATH}/${fname}`;
    const isParquet = fname.toLowerCase().endsWith(".parquet") || !!stored.isParquet;
    return {
      localMountPath: dirname(stored.localPath),
      localFileContext: isParquet
        ? parquetFileContext(parquetReadExpr(where), where, stored.schema.row_count)
        : csvFileContext(fname),
    };
  }
  return {};
}
