/**
 * Host-side parquet → CSV conversion (build log D12), so a REMOTE source
 * materialized by the Rust egress core lands on the wasm worker's proven
 * pandas-CSV path — the browser worker reads CSV, not parquet. Runs on the
 * shared in-process DuckDB (`host-duckdb.ts`): no Docker, no worker, no network.
 * `COPY` streams parquet→CSV on disk with bounded memory.
 *
 * Integration edge (DuckDB-WASM) → coverage-excluded; covered by a gated
 * integration test (HERMETIC_WASM_TEST).
 */
import { hostExec, _resetHostDuckDbForTests } from "./host-duckdb";
import { sqlLit } from "./sql-lit";

/**
 * Convert `parquetPath` → `csvPath` (with a header row). Both are host paths; the
 * caller owns their lifecycle. Throws if DuckDB cannot read the parquet.
 */
export async function parquetToCsv(parquetPath: string, csvPath: string): Promise<void> {
  await hostExec(
    `COPY (SELECT * FROM read_parquet('${sqlLit(parquetPath)}')) ` +
      `TO '${sqlLit(csvPath)}' (HEADER, FORMAT CSV)`
  );
}

/** Test-only: drop the memoized connection. */
export function _resetParquetConvertForTests(): void {
  _resetHostDuckDbForTests();
}
