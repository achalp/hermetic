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

  it("classifies nested / geometry types as complex so scalar aggregates are skipped", () => {
    // Guards against the substring-match bug where STRUCT(... DOUBLE ...)[] read
    // as a number and AVG() crashed. The profiler must detect complex types first.
    const s = buildSchemaScript("x.parquet", false, false);
    expect(s).toContain("'STRUCT', 'MAP', 'UNION', 'LIST', 'ARRAY', '[]', 'GEOMETRY'");
    expect(s).toContain("return 'complex'");
    expect(s).toContain("elif dtype == 'complex':");
  });
});

describe("buildRemoteParquetSchemaScript — reuses the shared tail", () => {
  const url = "https://host/data/lineitem.parquet";
  const s = buildRemoteParquetSchemaScript(url);

  it("loads the cloud + geo extensions before reading", () => {
    expect(s).toContain("INSTALL httpfs");
    expect(s).toContain("LOAD spatial");
  });

  it("pins s3_url_style from the env so vhost-only egress allowlists still read (F1)", () => {
    // Under the egress proxy AWS is reachable ONLY via bucket vhost; DuckDB
    // defaults to path-style and would 403. The script must honor the
    // HERMETIC_S3_URL_STYLE the gateway sets, exactly like the analysis prelude.
    expect(s).toContain('_os.environ.get("HERMETIC_S3_URL_STYLE")');
    expect(s).toContain("SET s3_url_style=?");
  });

  it("reads the remote URL directly and counts rows from footers (no scan)", () => {
    expect(s).toContain(`read_parquet('${url}')`);
    expect(s).toContain(`PATTERN = '${url}'`);
    // Row count comes from Parquet footer metadata, never a data scan.
    expect(s).toContain("parquet_file_metadata");
    // Bounded profiling read, never the whole remote dataset.
    expect(s).toContain("LIMIT {STATS_SAMPLE_SIZE}");
  });

  it("bounds the footer scan for large multi-shard datasets and extrapolates", () => {
    // Reading every footer over the network is too slow for 500+ shards; the
    // script samples a fixed number of files and scales by total file count.
    expect(s).toContain("FOOTER_SAMPLE_FILES");
    expect(s).toContain("glob('{PATTERN}')");
    expect(s).toContain("parquet_file_metadata([");
    expect(s).toContain("total_files");
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
    // ...and the glob/footer discovery runs off the bare pattern.
    expect(hive).toContain(`PATTERN = '${glob}'`);
  });
});
