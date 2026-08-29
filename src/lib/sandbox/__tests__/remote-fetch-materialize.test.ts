import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { materializeRemoteCsvForWasm } from "@/lib/sandbox/remote-fetch";

/**
 * The host-side WASM remote chain end to end (build log D13): a fake egress-fetch bin
 * serves a REAL parquet's bytes (mocking the network — a live bucket can't run in CI),
 * then materializeRemoteCsvForWasm materializes + converts it to CSV via DuckDB-WASM.
 * Gated (HERMETIC_WASM_TEST) because it boots DuckDB.
 */
const gated = process.env.HERMETIC_WASM_TEST ? describe : describe.skip;

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

gated("materializeRemoteCsvForWasm", () => {
  it("fetches (mocked) → parquet → CSV on the worker's local path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wasm-remote-"));
    try {
      const srcParquet = join(dir, "src.parquet");
      await writeParquet(
        "SELECT 'north' AS region, 190 AS revenue UNION ALL SELECT 'west', 380 ORDER BY revenue",
        srcParquet
      );

      // Fake bin: cat the parquet bytes to stdout (absolute /bin/cat → no PATH needed).
      const bin = join(dir, "fake-egress.sh");
      writeFileSync(bin, `#!/bin/sh\nexec /bin/cat '${srcParquet}'\n`);
      chmodSync(bin, 0o755);

      const { csvPath } = await materializeRemoteCsvForWasm(
        { remoteParquetUrl: "https://data.example.com/src.parquet" },
        { workDir: dir, binPath: bin }
      );
      expect(existsSync(csvPath)).toBe(true);
      const csv = readFileSync(csvPath, "utf8").trim();
      expect(csv).toBe("region,revenue\nnorth,190\nwest,380");
      // the intermediate parquet was cleaned up
      expect(
        readdirSync(dir).some((f) => f.startsWith("wasm-remote-") && f.endsWith(".parquet"))
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
