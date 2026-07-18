import { describe, it, expect } from "vitest";
import { isHivePartitionSegment, normalizeRemoteParquetUrl } from "@/lib/parquet/partition";

describe("isHivePartitionSegment", () => {
  it("recognizes key=value partition dirs", () => {
    expect(isHivePartitionSegment("theme=buildings")).toBe(true);
    expect(isHivePartitionSegment("type=building")).toBe(true);
    expect(isHivePartitionSegment("year=2024")).toBe(true);
    expect(isHivePartitionSegment("_col=x")).toBe(true);
  });

  it("rejects non-partition segments", () => {
    expect(isHivePartitionSegment("release")).toBe(false);
    expect(isHivePartitionSegment("2026-06-17.0")).toBe(false);
    expect(isHivePartitionSegment("part-00000.parquet")).toBe(false);
    expect(isHivePartitionSegment("=novalue")).toBe(false);
    expect(isHivePartitionSegment("key=")).toBe(false);
  });
});

describe("normalizeRemoteParquetUrl", () => {
  it("passes a single .parquet file through unchanged (not a folder, not hive)", () => {
    const r = normalizeRemoteParquetUrl("https://host/data/lineitem.parquet");
    expect(r).toEqual({
      readUrl: "https://host/data/lineitem.parquet",
      isFolder: false,
      isHivePartitioned: false,
    });
  });

  it("respects an explicit glob and infers hive from the path", () => {
    const r = normalizeRemoteParquetUrl("s3://b/theme=x/*.parquet");
    expect(r.readUrl).toBe("s3://b/theme=x/*.parquet");
    expect(r.isFolder).toBe(true);
    expect(r.isHivePartitioned).toBe(true);
  });

  it("expands an Overture theme/type prefix into a recursive glob with hive on", () => {
    const r = normalizeRemoteParquetUrl(
      "s3://overturemaps-us-west-2/release/2026-06-17.0/theme=buildings/type=building"
    );
    expect(r.readUrl).toBe(
      "s3://overturemaps-us-west-2/release/2026-06-17.0/theme=buildings/type=building/**/*.parquet"
    );
    expect(r.isFolder).toBe(true);
    expect(r.isHivePartitioned).toBe(true);
  });

  it("expands the dataset root so partition keys become columns", () => {
    const r = normalizeRemoteParquetUrl("s3://overturemaps-us-west-2/release/2026-06-17.0/");
    // trailing slash stripped, recursive glob appended
    expect(r.readUrl).toBe("s3://overturemaps-us-west-2/release/2026-06-17.0/**/*.parquet");
    expect(r.isFolder).toBe(true);
    // No key=value above here, so hive is only detected once you descend — but the
    // recursive glob still reaches the partitions; hive stays false at this depth.
    expect(r.isHivePartitioned).toBe(false);
  });

  it("expands a flat (non-hive) folder of shards", () => {
    const r = normalizeRemoteParquetUrl("s3://bucket/exports/mydata");
    expect(r.readUrl).toBe("s3://bucket/exports/mydata/**/*.parquet");
    expect(r.isFolder).toBe(true);
    expect(r.isHivePartitioned).toBe(false);
  });

  it("ignores a query string when checking the shape", () => {
    const r = normalizeRemoteParquetUrl("https://host/data/file.parquet?token=abc123");
    expect(r.isFolder).toBe(false);
    expect(r.readUrl).toBe("https://host/data/file.parquet?token=abc123");
  });
});
