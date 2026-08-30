import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `extractParquetSchemaHost`'s ORCHESTRATION, with DuckDB mocked out (build log
 * D25). The gated integration test proves it works against a real engine; these
 * pin the decisions made AROUND the engine — which query is asked, what happens
 * when the cheap one fails, and what is reported when the sample is smaller than
 * the dataset. Those are the parts a live-engine test would pass over silently.
 */

const hostQueryRows = vi.fn<(sql: string) => Promise<Record<string, unknown>[]>>();
const hostExec = vi.fn<(sql: string) => Promise<void>>();
vi.mock("@/lib/sandbox/wasm/host-duckdb", () => ({
  hostQueryRows: (sql: string) => hostQueryRows(sql),
  hostExec: (sql: string) => hostExec(sql),
}));

const readFile = vi.fn<(...a: unknown[]) => Promise<string>>();
const rm = vi.fn<(...a: unknown[]) => Promise<void>>();
vi.mock("node:fs/promises", () => ({
  mkdtemp: vi.fn(async () => "/tmp/pqprofile-x"),
  readFile: (...a: unknown[]) => readFile(...a),
  rm: (...a: unknown[]) => rm(...a),
}));

import { extractParquetSchemaHost } from "@/lib/parquet/host-schema";

const DESCRIBE = [
  { column_name: "n", column_type: "BIGINT" },
  { column_name: "s", column_type: "VARCHAR" },
];

/** Route each query by shape so tests state intent, not call order. */
type Row = Record<string, unknown>;
function answer(handlers: { describe?: Row[]; metadata?: Row[] | Error; count?: Row[] }) {
  hostQueryRows.mockImplementation(async (sql: string) => {
    if (sql.startsWith("DESCRIBE")) return handlers.describe ?? DESCRIBE;
    if (sql.includes("parquet_file_metadata")) {
      if (handlers.metadata instanceof Error) throw handlers.metadata;
      return handlers.metadata ?? [{ n: 1500 }];
    }
    if (sql.includes("COUNT(*)")) return handlers.count ?? [{ n: 42 }];
    throw new Error(`unexpected query: ${sql}`);
  });
}

beforeEach(() => {
  hostQueryRows.mockReset();
  hostExec.mockReset();
  hostExec.mockResolvedValue(undefined);
  readFile.mockReset();
  readFile.mockResolvedValue("n,s\n1,a\n2,b\n");
  rm.mockReset();
  rm.mockResolvedValue(undefined);
});

describe("extractParquetSchemaHost — orchestration", () => {
  const base = { csvId: "cid", filename: "f.parquet" };

  it("counts a single FILE directly — there is no footer shortcut worth taking", async () => {
    answer({ count: [{ n: 42 }] });
    const schema = await extractParquetSchemaHost({
      ...base,
      localPath: "/d/f.parquet",
      isFolder: false,
    });
    expect(schema.row_count).toBe(42);
    expect(hostQueryRows.mock.calls.some(([s]) => s.includes("parquet_file_metadata"))).toBe(false);
  });

  it("counts a FOLDER from parquet footers, not by scanning it", async () => {
    answer({ metadata: [{ n: 1500 }] });
    const schema = await extractParquetSchemaHost({
      ...base,
      localPath: "/d/set",
      isFolder: true,
      isHivePartitioned: true,
    });
    expect(schema.row_count).toBe(1500);
    // A COUNT(*) over the glob would read every data page of every part.
    expect(hostQueryRows.mock.calls.some(([s]) => s.includes("COUNT(*)"))).toBe(false);
  });

  it("falls back to a real COUNT when the footer function THROWS", async () => {
    // Older files / unusual writers can make parquet_file_metadata unavailable.
    // Reporting 0 rows there would silently mislabel the dataset as empty.
    answer({ metadata: new Error("no such function"), count: [{ n: 7 }] });
    const schema = await extractParquetSchemaHost({
      ...base,
      localPath: "/d/set",
      isFolder: true,
    });
    expect(schema.row_count).toBe(7);
  });

  it("falls back when the footer sum comes back as ZERO rather than trusting it", async () => {
    answer({ metadata: [{ n: 0 }], count: [{ n: 9 }] });
    const schema = await extractParquetSchemaHost({
      ...base,
      localPath: "/d/set",
      isFolder: true,
    });
    expect(schema.row_count).toBe(9);
  });

  it("takes column TYPES from DESCRIBE, overriding what the CSV sample looks like", async () => {
    // The sample writes "1"/"2" for the BIGINT and "a"/"b" for the VARCHAR; text
    // inference alone would be free to type `n` as something else.
    answer({ count: [{ n: 2 }] });
    const schema = await extractParquetSchemaHost({
      ...base,
      localPath: "/d/f.parquet",
      isFolder: false,
    });
    expect(schema.columns.map((c) => [c.name, c.dtype])).toEqual([
      ["n", "number"],
      ["s", "string"],
    ]);
  });

  it("reports the TRUE row count, not the number of rows it profiled", async () => {
    answer({ count: [{ n: 5_000_000 }] });
    readFile.mockResolvedValue("n,s\n1,a\n"); // one sampled row
    const schema = await extractParquetSchemaHost({
      ...base,
      localPath: "/d/f.parquet",
      isFolder: false,
    });
    expect(schema.row_count).toBe(5_000_000);
    expect(schema.source_type).toBe("file");
  });

  it("fails BEFORE sampling when the source has no readable columns", async () => {
    // DESCRIBE ... LIMIT 0 reads footers only, so an empty/unreadable folder costs
    // nothing to reject — and must not go on to COPY a sample out of it.
    answer({ describe: [] });
    await expect(
      extractParquetSchemaHost({ ...base, localPath: "/d/empty", isFolder: true })
    ).rejects.toThrow(/No readable Parquet columns/i);
    expect(hostExec).not.toHaveBeenCalled();
  });

  it("ignores a DESCRIBE row with no column name instead of keying on empty string", async () => {
    answer({
      describe: [...DESCRIBE, { column_name: "", column_type: "INTEGER" }],
      count: [{ n: 2 }],
    });
    const schema = await extractParquetSchemaHost({
      ...base,
      localPath: "/d/f.parquet",
      isFolder: false,
    });
    expect(schema.columns.map((c) => c.name)).toEqual(["n", "s"]);
  });

  it("survives a DESCRIBE row missing its type, typing it as a string", async () => {
    answer({ describe: [{ column_name: "n" }], count: [{ n: 1 }] });
    readFile.mockResolvedValue("n\na\n");
    const schema = await extractParquetSchemaHost({
      ...base,
      localPath: "/d/f.parquet",
      isFolder: false,
    });
    // "" maps to string — a missing type must not crash the connect or silently
    // become a number.
    expect(schema.columns[0]!.dtype).toBe("string");
  });

  it("falls back to COUNT when the footer query throws a NON-Error value", async () => {
    // DuckDB bindings have thrown plain strings; `err.message` on one is
    // undefined, and an unguarded read there would replace a recoverable
    // fallback with a crash.
    hostQueryRows.mockImplementation(async (sql: string) => {
      if (sql.startsWith("DESCRIBE")) return DESCRIBE;
      if (sql.includes("parquet_file_metadata")) throw "boom";
      return [{ n: 3 }];
    });
    const schema = await extractParquetSchemaHost({
      ...base,
      localPath: "/d/set",
      isFolder: true,
    });
    expect(schema.row_count).toBe(3);
  });

  it("cleans up its temp dir even when the sample COPY fails", async () => {
    answer({ count: [{ n: 1 }] });
    hostExec.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      extractParquetSchemaHost({ ...base, localPath: "/d/f.parquet", isFolder: false })
    ).rejects.toThrow(/disk full/);
    expect(rm).toHaveBeenCalledWith("/tmp/pqprofile-x", { recursive: true, force: true });
  });

  it("cleans up on the happy path too", async () => {
    answer({ count: [{ n: 2 }] });
    await extractParquetSchemaHost({ ...base, localPath: "/d/f.parquet", isFolder: false });
    expect(rm).toHaveBeenCalledWith("/tmp/pqprofile-x", { recursive: true, force: true });
  });

  it("does not fail the extraction when cleanup itself fails", async () => {
    answer({ count: [{ n: 2 }] });
    rm.mockRejectedValueOnce(new Error("EBUSY"));
    await expect(
      extractParquetSchemaHost({ ...base, localPath: "/d/f.parquet", isFolder: false })
    ).resolves.toBeDefined();
  });
});
