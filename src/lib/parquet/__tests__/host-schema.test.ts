import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mapDuckDbType,
  toRowCount,
  hostReadExpr,
  extractParquetSchemaHost,
  HOST_PROFILE_ROWS,
} from "@/lib/parquet/host-schema";

/**
 * Host-side (no-Docker) Parquet profiling — build log D24/D25. The pure units run
 * everywhere; the real end-to-end profile is gated on HERMETIC_WASM_TEST like the
 * other DuckDB-WASM integration tests (booting the engine is heavy).
 */

describe("mapDuckDbType", () => {
  it("maps the scalar families the profiler branches on", () => {
    expect(mapDuckDbType("BIGINT")).toBe("number");
    expect(mapDuckDbType("DECIMAL(18,4)")).toBe("number");
    expect(mapDuckDbType("DOUBLE")).toBe("number");
    expect(mapDuckDbType("TIMESTAMP WITH TIME ZONE")).toBe("date");
    expect(mapDuckDbType("DATE")).toBe("date");
    expect(mapDuckDbType("BOOLEAN")).toBe("boolean");
    expect(mapDuckDbType("VARCHAR")).toBe("string");
  });

  it("checks NESTED types first, so a struct carrying a DOUBLE is not read as a number", () => {
    // The exact shape that trips substring matching: the word DOUBLE appears
    // inside a struct definition. Order-dependent — this fails if the nested
    // check is moved below the numeric one.
    expect(mapDuckDbType("STRUCT(confidence DOUBLE)[]")).toBe("string");
    expect(mapDuckDbType("MAP(VARCHAR, BIGINT)")).toBe("string");
    expect(mapDuckDbType("GEOMETRY")).toBe("string");
    expect(mapDuckDbType("INTEGER[]")).toBe("string");
  });

  it("never emits 'complex' — it is not in the CSVSchema dtype union", () => {
    // The Docker script DOES emit "complex", which is out of contract. Matching
    // it here would put an unknown dtype into a stored schema.
    const dtypes = ["STRUCT(a INT)", "GEOMETRY", "MAP(VARCHAR,INT)"].map(mapDuckDbType);
    expect(dtypes).toEqual(["string", "string", "string"]);
  });
});

describe("toRowCount", () => {
  it("normalizes every shape a DuckDB count arrives in", () => {
    expect(toRowCount(1500)).toBe(1500);
    expect(toRowCount(BigInt(1500))).toBe(1500);
    expect(toRowCount("1500")).toBe(1500);
    // SUM(num_rows) over parquet footers came back as a QUOTED decimal string.
    expect(toRowCount('"1500"')).toBe(1500);
  });

  it("yields 0 rather than NaN for anything unreadable", () => {
    // A NaN would serialize into the schema and land in the prompt as "NaN rows".
    expect(toRowCount(undefined)).toBe(0);
    expect(toRowCount(null)).toBe(0);
    expect(toRowCount("not a number")).toBe(0);
    expect(toRowCount(Number.NaN)).toBe(0);
  });
});

describe("hostReadExpr", () => {
  it("reads a single file directly", () => {
    expect(hostReadExpr("/data/x.parquet", false)).toBe("read_parquet('/data/x.parquet')");
  });

  it("globs a folder recursively and opts into hive columns only when asked", () => {
    expect(hostReadExpr("/data/set", true)).toBe("read_parquet('/data/set/**/*.parquet')");
    expect(hostReadExpr("/data/set", true, true)).toBe(
      "read_parquet('/data/set/**/*.parquet', hive_partitioning=true)"
    );
    // A trailing slash must not produce a double slash in the glob.
    expect(hostReadExpr("/data/set/", true)).toBe("read_parquet('/data/set/**/*.parquet')");
  });

  it("escapes an apostrophe in the path instead of breaking out of the literal", () => {
    expect(hostReadExpr("/data/o'brien.parquet", false)).toBe(
      "read_parquet('/data/o''brien.parquet')"
    );
  });

  it("hive_partitioning is never set for a single file", () => {
    expect(hostReadExpr("/data/x.parquet", false, true)).toBe("read_parquet('/data/x.parquet')");
  });
});

const gated = process.env.HERMETIC_WASM_TEST ? describe : describe.skip;

gated("extractParquetSchemaHost (real DuckDB, no Docker)", () => {
  async function writeParquet(sql: string, dest: string): Promise<void> {
    const { hostExec } = await import("@/lib/sandbox/wasm/host-duckdb");
    await hostExec(`COPY (${sql}) TO '${dest}' (FORMAT PARQUET)`);
  }

  it("profiles a single file with DuckDB types and an exact row count", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-schema-"));
    try {
      const pq = join(dir, "in.parquet");
      await writeParquet(
        `SELECT CAST(i AS BIGINT) AS n, 'label-' || i AS s,
                DATE '2024-01-01' + CAST(i AS INTEGER) AS d, i % 2 = 0 AS flag
         FROM range(1200) t(i)`,
        pq
      );
      const schema = await extractParquetSchemaHost({
        localPath: pq,
        csvId: "cid",
        filename: "in.parquet",
        isFolder: false,
      });

      expect(schema.row_count).toBe(1200);
      expect(schema.source_type).toBe("file");
      const byName = Object.fromEntries(schema.columns.map((c) => [c.name, c.dtype]));
      // Types come from the parquet schema, NOT from re-inferring the CSV text.
      expect(byName).toEqual({ n: "number", s: "string", d: "date", flag: "boolean" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("profiles a hive folder: partition columns appear and the count spans all parts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-schema-hive-"));
    try {
      mkdirSync(join(dir, "theme=a"), { recursive: true });
      mkdirSync(join(dir, "theme=b"), { recursive: true });
      await writeParquet(
        "SELECT CAST(i AS BIGINT) AS n FROM range(1000) t(i)",
        join(dir, "theme=a", "p.parquet")
      );
      await writeParquet(
        "SELECT CAST(i AS BIGINT) AS n FROM range(500) t(i)",
        join(dir, "theme=b", "p.parquet")
      );

      const schema = await extractParquetSchemaHost({
        localPath: dir,
        csvId: "cid",
        filename: "hiveset",
        isFolder: true,
        isHivePartitioned: true,
      });

      // 1500 = both parts. A per-file count would have said 1000.
      expect(schema.row_count).toBe(1500);
      expect(schema.columns.map((c) => c.name)).toContain("theme");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("reports the TRUE row count even when it profiled only a bounded sample", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-schema-big-"));
    try {
      const pq = join(dir, "big.parquet");
      const rows = HOST_PROFILE_ROWS + 1000;
      await writeParquet(`SELECT CAST(i AS BIGINT) AS n FROM range(${rows}) t(i)`, pq);
      const schema = await extractParquetSchemaHost({
        localPath: pq,
        csvId: "cid",
        filename: "big.parquet",
        isFolder: false,
      });
      // The sample bounds the STATS, never the reported size — a prompt that
      // believes the dataset is 50k rows makes different (wrong) decisions.
      expect(schema.row_count).toBe(rows);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("fails loudly on a folder with no parquet in it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-schema-empty-"));
    try {
      await expect(
        extractParquetSchemaHost({
          localPath: dir,
          csvId: "cid",
          filename: "empty",
          isFolder: true,
        })
      ).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
