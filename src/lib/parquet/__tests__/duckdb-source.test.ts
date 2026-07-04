import { describe, it, expect } from "vitest";
import {
  parquetReadExpr,
  parquetFolderContext,
  parquetFileContext,
  resolveLocalSource,
  resolveRemoteSource,
  isSafeParquetUrl,
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

describe("isSafeParquetUrl", () => {
  it("accepts s3://, https://, gs://, azure globs", () => {
    expect(
      isSafeParquetUrl("s3://overturemaps-us-west-2/release/2024/theme=buildings/*.parquet")
    ).toBe(true);
    expect(isSafeParquetUrl("https://host/data/file.parquet")).toBe(true);
    expect(isSafeParquetUrl("gs://bucket/x.parquet")).toBe(true);
  });

  it("rejects a URL that could break out of the SQL string literal", () => {
    expect(isSafeParquetUrl("s3://b/x.parquet'); DROP TABLE t; --")).toBe(false); // quote + ;
    expect(isSafeParquetUrl("https://h/a`b.parquet")).toBe(false); // backtick
    expect(isSafeParquetUrl("https://h/a\\b.parquet")).toBe(false); // backslash
    expect(isSafeParquetUrl("https://h/a\nb")).toBe(false); // newline
  });

  it("rejects a non-object-store scheme and empty/overlong input", () => {
    expect(isSafeParquetUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeParquetUrl("/data/local/x.parquet")).toBe(false);
    expect(isSafeParquetUrl("")).toBe(false);
    expect(isSafeParquetUrl(null)).toBe(false);
    expect(isSafeParquetUrl("https://h/" + "a".repeat(3000))).toBe(false);
  });
});

describe("resolveRemoteSource", () => {
  it("prepends the cloud prelude and reads via read_parquet(url)", () => {
    const { localFileContext } = resolveRemoteSource("s3://bucket/data/*.parquet", 2_500_000_000);
    expect(localFileContext).toContain(DUCKDB_CLOUD_PRELUDE);
    expect(localFileContext).toContain("read_parquet('s3://bucket/data/*.parquet')");
    expect(localFileContext).toContain("2,500,000,000 rows");
    // Large-data guidance carries through for a huge remote dataset.
    expect(localFileContext).toContain("large dataset");
  });
});
