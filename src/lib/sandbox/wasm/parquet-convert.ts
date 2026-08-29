/**
 * Host-side parquet → CSV conversion (build log D12), so a REMOTE source
 * materialized by the Rust egress core lands on the wasm worker's proven
 * pandas-CSV path — the browser worker reads CSV, not parquet. Runs the
 * `@duckdb/duckdb-wasm` blocking bundle IN-PROCESS in Node (NODE_RUNTIME → real
 * filesystem), so there is NO Docker and NO worker: `COPY` streams parquet→CSV on
 * disk with bounded memory.
 *
 * Boots its OWN DuckDB via `createRequire` (ESM-safe) rather than reusing
 * `duckdb-engine` — that engine's `eval("require")` only resolves when its source is
 * shipped into a CJS worker, so it cannot be called directly here. The connection is
 * memoized at module scope (this file runs in-process; it is never `.toString()`-
 * shipped, so no globalThis singleton is needed).
 *
 * Integration edge (DuckDB-WASM) → coverage-excluded; covered by a gated
 * integration test (HERMETIC_WASM_TEST).
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

interface BlockingConn {
  query(sql: string): unknown;
}
let connPromise: Promise<BlockingConn> | null = null;

async function getConnection(): Promise<BlockingConn> {
  if (!connPromise) {
    connPromise = (async () => {
      const require = createRequire(import.meta.url);
      const entry = "@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs";
      // Dynamic require keeps @duckdb/duckdb-wasm OUT of the client bundle.
      const duckdb = require(entry);
      const distDir = dirname(require.resolve(entry));
      const bundles = {
        mvp: {
          mainModule: join(distDir, "duckdb-mvp.wasm"),
          mainWorker: join(distDir, "duckdb-node-mvp.worker.cjs"),
        },
        eh: {
          mainModule: join(distDir, "duckdb-eh.wasm"),
          mainWorker: join(distDir, "duckdb-node-eh.worker.cjs"),
        },
      };
      const db = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
      await db.instantiate();
      return db.connect() as BlockingConn;
    })();
  }
  return connPromise;
}

/** Escape a host path for a DuckDB single-quoted string literal. */
function sqlLit(p: string): string {
  return p.replace(/'/g, "''");
}

/**
 * Convert `parquetPath` → `csvPath` (with a header row). Both are host paths; the
 * caller owns their lifecycle. Throws if DuckDB cannot read the parquet.
 */
export async function parquetToCsv(parquetPath: string, csvPath: string): Promise<void> {
  const conn = await getConnection();
  conn.query(
    `COPY (SELECT * FROM read_parquet('${sqlLit(parquetPath)}')) ` +
      `TO '${sqlLit(csvPath)}' (HEADER, FORMAT CSV)`
  );
}

/** Test-only: drop the memoized connection. */
export function _resetParquetConvertForTests(): void {
  connPromise = null;
}
