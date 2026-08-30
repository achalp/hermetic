/**
 * Local Parquet → CSV on the host, so the built-in (wasm) runtime can ANALYZE a
 * local parquet file or folder (build log D25).
 *
 * ── Why a CSV bridge, and what it costs ──
 * The webview worker has no filesystem, so it cannot bind-mount the way Docker
 * does. The remote wasm path already solved the same problem the same way (D13):
 * materialize host-side, hand the worker a `/data/input.csv`, and let it run its
 * proven pandas path. Doing the identical thing for a LOCAL parquet reuses that
 * machinery instead of inventing a second delivery shape.
 *
 * The cost is real and bounded on purpose: a CSV bridge materializes the WHOLE
 * dataset, which is exactly what parquet exists to avoid. So this refuses rather
 * than degrades past {@link WASM_LOCAL_CSV_MAX_ROWS} / {@link WASM_LOCAL_CSV_MAX_BYTES},
 * naming Docker in the error instead of silently filling the disk or OOM-ing the
 * worker. The upgrade that removes the ceiling is serving the local file over a
 * ranged endpoint so DuckDB-in-the-worker reads only the row groups it needs —
 * the same trick the remote path already uses (D18–D21) — which is why the cap
 * lives here as one named constant rather than being spread through the callers.
 */
import { mkdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hostExec } from "@/lib/sandbox/wasm/host-duckdb";
import { sqlLit } from "@/lib/sandbox/wasm/sql-lit";
import { hostReadExpr } from "./host-schema";
import { logger } from "@/lib/logger";

/**
 * Row ceiling for the CSV bridge. Above this a local parquet is genuinely
 * big-data and belongs on the Docker path (or, later, the ranged worker read) —
 * materializing it as text would cost more than the analysis.
 */
export const WASM_LOCAL_CSV_MAX_ROWS = 2_000_000;

/**
 * Byte ceiling on the PRODUCED CSV. Rows alone do not bound the size — a few
 * hundred wide string columns blow past the row cap's intent — so the written
 * file is checked too, and deleted if it lands over.
 */
export const WASM_LOCAL_CSV_MAX_BYTES = 512 * 1024 * 1024;

/** Human-readable refusal, shared by both ceilings so the guidance is identical. */
function tooLarge(what: string): Error {
  return new Error(
    `This local Parquet source is too large for the built-in runtime (${what}). ` +
      `The built-in runtime reads it by converting the whole dataset to CSV first. ` +
      `Switch to the Docker sandbox runtime in Settings to analyze it in place.`
  );
}

/**
 * Convert a local parquet file or folder to a single CSV under `workDir` and
 * return its path. The caller owns the file's lifecycle (the run cleans it up).
 */
export async function materializeLocalParquetCsvForWasm(args: {
  /** The file or folder path the user selected. */
  localPath: string;
  isFolder: boolean;
  isHivePartitioned?: boolean;
  /** Row count from the stored schema — the cheap pre-check, before any writing. */
  rowCount: number;
  workDir: string;
}): Promise<{ csvPath: string }> {
  const { localPath, isFolder, isHivePartitioned, rowCount, workDir } = args;

  if (rowCount > WASM_LOCAL_CSV_MAX_ROWS) {
    throw tooLarge(`${rowCount.toLocaleString()} rows`);
  }

  await mkdir(workDir, { recursive: true });
  const csvPath = join(workDir, `wasm-local-${randomUUID()}.csv`);
  const readExpr = hostReadExpr(localPath, isFolder, isHivePartitioned);

  await hostExec(`COPY (SELECT * FROM ${readExpr}) TO '${sqlLit(csvPath)}' (HEADER, FORMAT CSV)`);

  const bytes = await stat(csvPath).then((s) => s.size);
  if (bytes > WASM_LOCAL_CSV_MAX_BYTES) {
    await unlink(csvPath).catch(() => {});
    throw tooLarge(`${Math.round(bytes / 1024 / 1024)} MB as CSV`);
  }

  logger.info("WASM local Parquet materialized to CSV", { isFolder, rowCount, bytes });
  return { csvPath };
}
