import { describe, it, expect, vi, beforeEach } from "vitest";
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

describe("the BYTE ceiling — a row cap alone does not bound size", () => {
  /**
   * The row pre-check cannot see width: a few hundred wide string columns blow
   * past its intent while staying under it. So the WRITTEN file is checked too.
   * DuckDB is mocked here — the guard is about what happens AFTER the COPY.
   */
  const hostExec = vi.fn<(sql: string) => Promise<void>>();
  const stat = vi.fn();
  const unlink = vi.fn<(...a: unknown[]) => Promise<void>>();

  beforeEach(() => {
    vi.resetModules();
    hostExec.mockReset();
    hostExec.mockResolvedValue(undefined);
    unlink.mockReset();
    unlink.mockResolvedValue(undefined);
    vi.doMock("@/lib/sandbox/wasm/host-duckdb", () => ({ hostExec }));
    vi.doMock("node:fs/promises", () => ({
      mkdir: vi.fn(async () => {}),
      stat,
      unlink,
    }));
  });

  async function run(bytes: number) {
    stat.mockResolvedValue({ size: bytes });
    const mod = await import("@/lib/parquet/host-materialize");
    return mod.materializeLocalParquetCsvForWasm({
      localPath: "/d/f.parquet",
      isFolder: false,
      rowCount: 10,
      workDir: "/tmp/w",
    });
  }

  it("refuses a CSV that lands over the ceiling, and DELETES the partial file", async () => {
    const { WASM_LOCAL_CSV_MAX_BYTES } = await import("@/lib/parquet/host-materialize");
    await expect(run(WASM_LOCAL_CSV_MAX_BYTES + 1)).rejects.toThrow(/too large/i);
    // Leaving it would fill the disk AND leave something that looks like a result.
    expect(unlink).toHaveBeenCalledTimes(1);
  });

  it("still reports the CEILING when deleting the oversized file also fails", async () => {
    // A cleanup failure masking the real error would leave the user staring at
    // "EPERM" instead of "too large — switch to Docker".
    const { WASM_LOCAL_CSV_MAX_BYTES } = await import("@/lib/parquet/host-materialize");
    unlink.mockRejectedValueOnce(new Error("EPERM"));
    await expect(run(WASM_LOCAL_CSV_MAX_BYTES + 1)).rejects.toThrow(/too large/i);
  });

  it("reports the size in MB, so the refusal says something the user can act on", async () => {
    const { WASM_LOCAL_CSV_MAX_BYTES } = await import("@/lib/parquet/host-materialize");
    await expect(run(WASM_LOCAL_CSV_MAX_BYTES + 1)).rejects.toThrow(/\d+ MB as CSV/);
  });

  it("accepts a CSV exactly AT the ceiling and keeps it", async () => {
    const { WASM_LOCAL_CSV_MAX_BYTES } = await import("@/lib/parquet/host-materialize");
    const { csvPath } = await run(WASM_LOCAL_CSV_MAX_BYTES);
    expect(csvPath).toMatch(/^\/tmp\/w\/wasm-local-.*\.csv$/);
    expect(unlink).not.toHaveBeenCalled();
  });

  it("COPYs through a hive-aware read expression for a folder source", async () => {
    stat.mockResolvedValue({ size: 10 });
    const mod = await import("@/lib/parquet/host-materialize");
    await mod.materializeLocalParquetCsvForWasm({
      localPath: "/d/set",
      isFolder: true,
      isHivePartitioned: true,
      rowCount: 10,
      workDir: "/tmp/w",
    });
    const sql = hostExec.mock.calls[0]![0];
    expect(sql).toContain("/d/set/**/*.parquet");
    expect(sql).toContain("hive_partitioning=true");
    expect(sql).toContain("(HEADER, FORMAT CSV)");
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
