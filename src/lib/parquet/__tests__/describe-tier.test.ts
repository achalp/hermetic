/**
 * The DESCRIBE tier — the inclusion floor for remote Parquet.
 *
 * A table only needs column names and types to be usable by generated SQL;
 * statistics improve PLANS. Treating them as a precondition for ACCESS is what
 * dropped Overture division_area out of a question after two ~2.1-minute
 * profile failures, while the query that ultimately answered that question read
 * the same table's bbox and names columns with no profile at all.
 */
import { describe, it, expect } from "vitest";
import {
  buildRemoteDescribeScript,
  buildRemoteParquetSchemaScript,
} from "@/lib/parquet/schema-script";

const URL_ = "s3://overturemaps/release/theme=divisions/type=division_area/*.parquet";

describe("buildRemoteDescribeScript", () => {
  const script = buildRemoteDescribeScript(URL_, "", true);

  it("reads metadata only — no row egress at all", () => {
    // The prefix materialization is THE cost (~50s+ on a fat remote source).
    expect(script).not.toContain("stats_data");
    expect(script).not.toContain("STATS_TABLE");
    // ...and none of the aggregate machinery that consumes it.
    expect(script).not.toContain("CORR(");
    expect(script).not.toContain("approx_quantile");
  });

  it("still derives real column types and a footer row count", () => {
    expect(script).toContain("DESCRIBE SELECT * FROM");
    expect(script).toContain("parquet_file_metadata");
    expect(script).toContain("map_dtype");
  });

  it("marks every column UNPROFILED rather than inventing statistics", () => {
    expect(script).toContain("'kind': 'unprofiled'");
    expect(script).toContain("'null_count': 0");
    // No fabricated distributional claims anywhere in the emitted columns.
    expect(script).not.toContain("'distinct_count'");
    expect(script).not.toContain("'top_values'");
  });

  it("reports whether the footer row count is EXACT or extrapolated", () => {
    // A 500-file dataset is counted from a spread sample of footers and scaled;
    // presenting that as exact is the quiet lie this tier exists to avoid.
    expect(script).toContain("'row_count_exact'");
    expect(script).toContain("row_count_exact = (total_files <= FOOTER_SAMPLE_FILES)");
  });

  it("emits the SAME output envelope as the profile tier", () => {
    // Both tiers write one JSON file with the same keys, so every consumer,
    // cache and registration path is shared — they differ only in `meta`.
    for (const key of ["'row_count'", "'columns'", "'sample_rows'", "'detected_domain'"]) {
      expect(script).toContain(key);
    }
    expect(script).toContain("OUTPUT_PATH = globals().get('OUTPUT_PATH', '/data/output.json')");
  });

  it("shares its setup byte-for-byte with the profile script", () => {
    // Types and row counts MUST be derived identically in both tiers: upgrading
    // a described table to a profiled one may add statistics, never change a
    // column's dtype or its row count.
    const full = buildRemoteParquetSchemaScript(URL_, "", true);
    const sharedSetup = script.slice(0, script.indexOf("# Map DuckDB"));
    expect(sharedSetup.length).toBeGreaterThan(500);
    expect(full.startsWith(sharedSetup)).toBe(true);
  });

  it("is a fraction of the profile script, and honours a per-entity output path", () => {
    const full = buildRemoteParquetSchemaScript(URL_, "", true);
    expect(script.length).toBeLessThan(full.length / 3);
    expect(buildRemoteDescribeScript(URL_, "", true, "/data/e3.json")).toContain(
      'OUTPUT_PATH = "/data/e3.json"'
    );
  });

  it("keeps the remote credential + s3-url-style plumbing of the profile path", () => {
    // Same egress-sensitive setup: vhost-only allowlists 403 every s3 read.
    const authed = buildRemoteDescribeScript(URL_, "SET s3_access_key_id='k'", true);
    expect(authed).toContain("SET s3_access_key_id='k'");
    expect(authed).toContain("HERMETIC_S3_URL_STYLE");
  });
});

describe("spread sample + footer-exact ranges (remote)", () => {
  const script = buildRemoteParquetSchemaScript(URL_, "", true, undefined, 50_000);

  /**
   * VERIFIED IN A CONTAINER against 750,000 rows across 3 files where only the
   * last file holds the global maximum (lon 0..2,249,999):
   *
   *   OLD (500k head prefix)     max = 1,249,999   ← WRONG, and unqualified
   *   NEW 500k (spread+footers)  max = 2,249,999   ← exact
   *   NEW  50k (spread+footers)  max = 2,249,999   ← exact, 1/10th the rows
   *
   * So the shallow new profile is MORE accurate on ranges than the old deep one.
   * Non-range statistics were byte-identical where unaffected (zero_count,
   * negative_count, std_dev), and the column/meta shape is unchanged.
   */
  it("takes numeric min/max from the FOOTERS, not from the sample", () => {
    expect(script).toContain("parquet_metadata");
    expect(script).toContain("stats_min");
    expect(script).toContain("FOOTER_RANGES");
    // The sample's own range remains the fallback when a writer recorded no stats.
    expect(script).toContain("_fmin if _fmin is not None else safe_float(row[0])");
  });

  it("spreads the sample across files instead of reading the head", () => {
    expect(script).toContain("SPREAD_FILES = 32");
    expect(script).toContain("UNION ALL");
    expect(script).toContain("PROFILE_BASIS_KIND = 'spread_sample'");
  });

  it("keeps a bare LIMIT for a SINGLE-file source — nothing to spread across", () => {
    expect(script).toContain("LIMIT {STATS_SAMPLE_SIZE}");
  });

  it("per-file UNION ALL, because one LIMIT over a glob does not distribute", () => {
    // The same pushdown lesson as the OR-ed bbox trap: the engine would read the
    // leading files again and the spread would be decorative.
    const stats = script.slice(script.indexOf("_spread = []"));
    expect(stats).toContain("UNION ALL");
    expect(stats).toContain("read_parquet('");
  });
});
