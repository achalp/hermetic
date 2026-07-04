import { describe, it, expect } from "vitest";
import {
  parquetReadExpr,
  parquetFolderContext,
  parquetFileContext,
  resolveLocalSource,
  DUCKDB_CLOUD_PRELUDE,
  duckdbCloudPreludePy,
} from "@/lib/parquet/duckdb-source";
import type { StoredCSV, CSVSchema } from "@/lib/types";

function storedWith(over: Partial<StoredCSV> & { row_count?: number }): StoredCSV {
  const schema = { row_count: over.row_count ?? 1000 } as CSVSchema;
  return { schema, filePath: "", createdAt: 0, ...over } as StoredCSV;
}

describe("parquetReadExpr", () => {
  it("builds a plain read_parquet for a path or URL", () => {
    expect(parquetReadExpr("/data/local/x.parquet")).toBe("read_parquet('/data/local/x.parquet')");
    expect(parquetReadExpr("s3://bucket/*.parquet")).toBe("read_parquet('s3://bucket/*.parquet')");
  });

  it("adds hive_partitioning when requested", () => {
    expect(parquetReadExpr("/data/local/**/*.parquet", true)).toBe(
      "read_parquet('/data/local/**/*.parquet', hive_partitioning=true)"
    );
  });
});

describe("cloud extension prelude", () => {
  it("installs + loads both httpfs and spatial", () => {
    expect(DUCKDB_CLOUD_PRELUDE).toContain("INSTALL httpfs");
    expect(DUCKDB_CLOUD_PRELUDE).toContain("LOAD httpfs");
    expect(DUCKDB_CLOUD_PRELUDE).toContain("INSTALL spatial");
    expect(DUCKDB_CLOUD_PRELUDE).toContain("LOAD spatial");
  });
  it("wraps the prelude in a duckdb.sql(...) call with the given connection var", () => {
    expect(duckdbCloudPreludePy()).toBe(`duckdb.sql("${DUCKDB_CLOUD_PRELUDE}")`);
    expect(duckdbCloudPreludePy("con")).toBe(`con.sql("${DUCKDB_CLOUD_PRELUDE}")`);
  });
});

describe("parquet context builders", () => {
  it("folder context creates a view and includes the large-data warning past 1M rows", () => {
    const ctx = parquetFolderContext("read_parquet('X')", 5_000_000, false);
    expect(ctx).toContain("CREATE OR REPLACE VIEW data AS SELECT * FROM read_parquet('X')");
    expect(ctx).toContain("large dataset");
    expect(ctx).not.toContain("Hive-partitioned");
  });

  it("folder context omits the large-data warning under 1M rows and notes hive columns", () => {
    const ctx = parquetFolderContext("read_parquet('X', hive_partitioning=true)", 1000, true);
    expect(ctx).not.toContain("large dataset");
    expect(ctx).toContain("Hive-partitioned");
    expect(ctx).toContain("Partition columns");
  });

  it("single-file context reads via duckdb and names where the data is", () => {
    const ctx = parquetFileContext(
      "read_parquet('/data/local/a.parquet')",
      "/data/local/a.parquet",
      10
    );
    expect(ctx).toContain(
      "duckdb.sql(\"SELECT * FROM read_parquet('/data/local/a.parquet')\").df()"
    );
    expect(ctx).toContain("Do NOT read from /data/input.csv");
  });
});

describe("resolveLocalSource", () => {
  it("mounts the folder itself and builds folder context for a Parquet folder", () => {
    const r = resolveLocalSource(
      storedWith({ localFolderPath: "/host/data", isParquet: true, row_count: 2_000_000 })
    );
    expect(r.localMountPath).toBe("/host/data");
    expect(r.localFileContext).toContain("folder of Parquet files");
    expect(r.localFileContext).toContain("read_parquet('/data/local/**/*.parquet')");
  });

  it("mounts the parent dir and builds Parquet context for a single .parquet file", () => {
    const r = resolveLocalSource(
      storedWith({ localPath: "/host/dir/sales.parquet", isParquet: true })
    );
    expect(r.localMountPath).toBe("/host/dir");
    expect(r.localFileContext).toContain("read_parquet('/data/local/sales.parquet')");
  });

  it("uses pandas read_csv context for a non-parquet local file", () => {
    const r = resolveLocalSource(storedWith({ localPath: "/host/dir/data.csv", isParquet: false }));
    expect(r.localMountPath).toBe("/host/dir");
    expect(r.localFileContext).toContain('pd.read_csv("/data/local/data.csv")');
  });

  it("returns empty for a non-local (upload/warehouse) source", () => {
    expect(resolveLocalSource(storedWith({}))).toEqual({});
  });
});
