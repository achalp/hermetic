import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { parquetToCsv } from "@/lib/sandbox/wasm/parquet-convert";

/**
 * Host-side parquet→CSV (build log D12) using DuckDB-WASM in-process (no Docker).
 * Gated like the other DuckDB-WASM integration tests (HERMETIC_WASM_TEST) — the CI
 * wasm-parity job sets it; the default unit run skips (the engine boot is heavy).
 */
const gated = process.env.HERMETIC_WASM_TEST ? describe : describe.skip;

// A tiny helper to WRITE the source parquet with the same blocking bundle.
async function writeParquet(sql: string, dest: string): Promise<void> {
  const require = createRequire(import.meta.url);
  const entry = "@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs";
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
  db.connect().query(`COPY (${sql}) TO '${dest}' (FORMAT PARQUET)`);
}

gated("parquetToCsv", () => {
  it("converts a real parquet file to CSV with a header (no Docker)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pq2csv-"));
    try {
      const pq = join(dir, "in.parquet");
      const csv = join(dir, "out.csv");
      await writeParquet("SELECT 1 AS a, 'x' AS b UNION ALL SELECT 2, 'y' ORDER BY a", pq);
      await parquetToCsv(pq, csv);
      expect(readFileSync(csv, "utf8").trim()).toBe("a,b\n1,x\n2,y");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
