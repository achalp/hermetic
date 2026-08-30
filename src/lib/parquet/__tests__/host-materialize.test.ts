import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeLocalParquetCsvForWasm,
  WASM_LOCAL_CSV_MAX_ROWS,
} from "@/lib/parquet/host-materialize";

/**
 * The CSV bridge that lets the built-in (wasm) runtime read a LOCAL parquet
 * source (build log D25). The ceiling test runs everywhere — it must refuse
 * BEFORE touching DuckDB, which is the whole point of the pre-check.
 */

describe("materializeLocalParquetCsvForWasm — the ceiling refuses, it does not degrade", () => {
  it("refuses an oversized dataset before booting DuckDB or writing anything", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "wasm-local-cap-"));
    try {
      await expect(
        materializeLocalParquetCsvForWasm({
          // A path that does not exist: if the row pre-check did NOT run first,
          // this would fail with a DuckDB "no such file" instead of the ceiling.
          localPath: "/nonexistent/huge.parquet",
          isFolder: false,
          rowCount: WASM_LOCAL_CSV_MAX_ROWS + 1,
          workDir,
        })
      ).rejects.toThrow(/too large for the built-in runtime/i);

      // And it left no partial file behind to be mistaken for a result.
      expect(await readdir(workDir)).toEqual([]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("names the Docker runtime in the refusal, so the message is actionable", async () => {
    await expect(
      materializeLocalParquetCsvForWasm({
        localPath: "/nonexistent/huge.parquet",
        isFolder: false,
        rowCount: WASM_LOCAL_CSV_MAX_ROWS + 1,
        workDir: tmpdir(),
      })
    ).rejects.toThrow(/Docker sandbox runtime/);
  });

  it("allows a dataset exactly AT the ceiling (the cap is inclusive)", async () => {
    // Proven by the failure mode: at the cap it must get PAST the pre-check and
    // fail on the missing file instead. (Verified by mutation — raising this
    // rowCount above the cap makes the assertion fail.)
    const workDir = mkdtempSync(join(tmpdir(), "wasm-local-atcap-"));
    try {
      await expect(
        materializeLocalParquetCsvForWasm({
          localPath: "/nonexistent/at-cap.parquet",
          isFolder: false,
          rowCount: WASM_LOCAL_CSV_MAX_ROWS,
          workDir,
        })
      ).rejects.not.toThrow(/too large/i);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

const gated = process.env.HERMETIC_WASM_TEST ? describe : describe.skip;

gated("materializeLocalParquetCsvForWasm (real DuckDB, no Docker)", () => {
  async function writeParquet(sql: string, dest: string): Promise<void> {
    const { hostExec } = await import("@/lib/sandbox/wasm/host-duckdb");
    await hostExec(`COPY (${sql}) TO '${dest}' (FORMAT PARQUET)`);
  }

  it("converts a single local parquet to a CSV the worker can read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wasm-local-file-"));
    try {
      const pq = join(dir, "in.parquet");
      await writeParquet("SELECT 1 AS a, 'x' AS b UNION ALL SELECT 2, 'y' ORDER BY a", pq);
      const { csvPath } = await materializeLocalParquetCsvForWasm({
        localPath: pq,
        isFolder: false,
        rowCount: 2,
        workDir: dir,
      });
      expect(readFileSync(csvPath, "utf8").trim()).toBe("a,b\n1,x\n2,y");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("folds a hive FOLDER into one CSV, partition column included", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wasm-local-hive-"));
    try {
      mkdirSync(join(dir, "theme=a"), { recursive: true });
      mkdirSync(join(dir, "theme=b"), { recursive: true });
      await writeParquet("SELECT 1 AS n", join(dir, "theme=a", "p.parquet"));
      await writeParquet("SELECT 2 AS n", join(dir, "theme=b", "p.parquet"));
      const { csvPath } = await materializeLocalParquetCsvForWasm({
        localPath: dir,
        isFolder: true,
        isHivePartitioned: true,
        rowCount: 2,
        workDir: join(dir, "out"),
      });
      const csv = readFileSync(csvPath, "utf8");
      // Without hive_partitioning the `theme` column would silently vanish and a
      // question grouping on it would change meaning rather than fail.
      expect(csv.split("\n")[0]).toContain("theme");
      expect(csv).toContain("a");
      expect(csv).toContain("b");
      expect(existsSync(csvPath)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
