import { describe, it, expect } from "vitest";
import { buildSchemaScript, buildRemoteParquetSchemaScript } from "@/lib/parquet/schema-script";

describe("buildSchemaScript (local) — unchanged structure", () => {
  it("reads the mounted single Parquet file and writes output.json", () => {
    const s = buildSchemaScript("sales.parquet", false, false);
    // The path is bound to DATA_PATH, then read via read_parquet('{DATA_PATH}').
    expect(s).toContain("DATA_PATH = '/data/local/sales.parquet'");
    expect(s).toContain("read_parquet('{DATA_PATH}')");
    expect(s).toContain("/data/output.json");
    expect(s).toContain("def map_dtype"); // the shared stats tail
  });

  it("globs a Hive-partitioned folder", () => {
    const s = buildSchemaScript("x", true, true);
    expect(s).toContain("/data/local/**/*.parquet");
    expect(s).toContain("hive_partitioning=true");
  });
});

describe("buildRemoteParquetSchemaScript — reuses the shared tail", () => {
  const url = "https://host/data/lineitem.parquet";
  const s = buildRemoteParquetSchemaScript(url);

  it("loads the cloud + geo extensions before reading", () => {
    expect(s).toContain("INSTALL httpfs");
    expect(s).toContain("LOAD spatial");
  });

  it("reads the remote URL directly and counts rows from footers (no scan)", () => {
    expect(s).toContain(`read_parquet('${url}')`);
    expect(s).toContain(`parquet_file_metadata('${url}')`);
    // Bounded profiling read, never the whole remote dataset.
    expect(s).toContain("LIMIT {STATS_SAMPLE_SIZE}");
  });

  it("shares the exact same stats/output tail as the local builder", () => {
    // The tail is source-agnostic; both scripts must end with the identical
    // profiling + output logic (the whole point of the refactor).
    const local = buildSchemaScript("x.parquet", false, false);
    const tailMarker = "# Map DuckDB types to schema dtypes";
    expect(s.slice(s.indexOf(tailMarker))).toBe(local.slice(local.indexOf(tailMarker)));
  });

  it("adds hive_partitioning to the read for a partitioned folder glob", () => {
    const glob = "s3://overturemaps-us-west-2/release/2026-06-17.0/theme=buildings/**/*.parquet";
    const hive = buildRemoteParquetSchemaScript(glob, "", true);
    // The data read uses the hive flag so partition keys surface as columns...
    expect(hive).toContain(`read_parquet('${glob}', hive_partitioning=true)`);
    // ...but the footer row-count query globs the files without it.
    expect(hive).toContain(`parquet_file_metadata('${glob}')`);
  });
});
