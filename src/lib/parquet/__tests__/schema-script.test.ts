import { describe, it, expect } from "vitest";
import {
  buildSchemaScript,
  buildRemoteParquetSchemaScript,
  buildWasmRemoteSchemaScript,
  WASM_SCHEMA_SAMPLE_ROWS,
  WASM_SCHEMA_FOOTER_FILES,
} from "@/lib/parquet/schema-script";

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

describe("buildWasmRemoteSchemaScript (build log D27)", () => {
  /**
   * The script the WORKER runs for a remote source. What it must NOT contain is
   * as load-bearing as what it must: the worker holds range tokens, not
   * credentials, and giving it cloud SQL would be handing it a destination.
   */
  const ALIASES = ["theme=buildings/type=building/part-0.parquet", "theme=b/part-1.parquet"];

  it("reads the token-bound ALIASES, never a URL or a bucket key", () => {
    const script = buildWasmRemoteSchemaScript(ALIASES, true);
    expect(script).toContain("theme=buildings/type=building/part-0.parquet");
    expect(script).not.toMatch(/https?:\/\//);
    expect(script).not.toContain("s3://");
  });

  it("carries NO cloud prelude, NO credentials, NO s3_url_style", () => {
    const script = buildWasmRemoteSchemaScript(ALIASES, true);
    expect(script).not.toContain("INSTALL httpfs");
    expect(script).not.toContain("httpfs");
    expect(script).not.toContain("s3_url_style");
    expect(script).not.toMatch(/CREATE\s+SECRET/i);
    expect(script).not.toContain("HERMETIC_S3_URL_STYLE");
  });

  it("keeps hive_partitioning conditional — a non-hive source must not derive columns", () => {
    expect(buildWasmRemoteSchemaScript(ALIASES, true)).toContain("hive_partitioning=true");
    // The flag lives behind IS_HIVE, so a false build carries the literal but
    // never the enabled read: assert on the switch, which is what decides.
    expect(buildWasmRemoteSchemaScript(ALIASES, false)).toContain("IS_HIVE = False");
    expect(buildWasmRemoteSchemaScript(ALIASES, true)).toContain("IS_HIVE = True");
  });

  it("emits the alias list as JSON, so a quote in a key cannot break the Python", () => {
    // SQL escapes a quote by DOUBLING it; inside a Python literal that silently
    // concatenates instead. JSON escaping is what keeps the two apart.
    const script = buildWasmRemoteSchemaScript(["od'd/part-0.parquet"], false);
    expect(script).toContain('ALL_FILES = ["od\'d/part-0.parquet"]');
    // ...and the SQL quoting happens in Python, once.
    expect(script).toContain(`f.replace("'", "''")`);
  });

  it("writes /data/output.json — the file worker-source.ts returns as the envelope", () => {
    // The whole reason extraction reuses the profiler instead of forking it.
    expect(buildWasmRemoteSchemaScript(ALIASES, false)).toContain("/data/output.json");
  });

  it("bounds BOTH costs the worker actually pays: footers read and rows materialized", () => {
    const script = buildWasmRemoteSchemaScript(ALIASES, false);
    expect(script).toContain(`FOOTER_SAMPLE_FILES = ${WASM_SCHEMA_FOOTER_FILES}`);
    expect(script).toContain(`STATS_SAMPLE_SIZE = ${WASM_SCHEMA_SAMPLE_ROWS}`);
    // An order of magnitude under the container's 500k: this table lives in the
    // WASM heap and arrives over ranged reads.
    expect(WASM_SCHEMA_SAMPLE_ROWS).toBeLessThan(500_000);
    expect(script).not.toContain("STATS_SAMPLE_SIZE = 500_000");
  });

  it("refuses to build a script with no files rather than emitting read_parquet([])", () => {
    expect(() => buildWasmRemoteSchemaScript([], false)).toThrow(/no files/i);
  });
});

describe("remote profiling omits fat GEOMETRY/BLOB columns (the division_area timeout)", () => {
  const remote = buildRemoteParquetSchemaScript(
    "s3://b/release/theme=divisions/type=division_area/**",
    "",
    true
  );

  it("builds the stats table from an explicit column list, skipping GEOMETRY/BLOB", () => {
    // Pulling 500k rows of boundary polygons over the egress proxy is what made
    // an 8-file entity time out at 59s while a 512-file entity profiled fine.
    expect(remote).toContain("SKIPPED_COLS = {c for c, t, *_ in describe");
    expect(remote).toContain("'GEOMETRY', 'BLOB'");
    expect(remote).toContain("c not in SKIPPED_COLS");
    // The bare star is only used when nothing is skipped.
    expect(remote).toContain('_cols = "*"');
  });

  it("reports a skipped column as UNPROFILED rather than inventing stats", () => {
    // A geometry column reported as 100% null (or as 0 distinct values) would be
    // a measurement nobody took, and the model would act on it. The column still
    // gets a structurally valid ColumnMeta — a null meta crashes every consumer
    // that switches on meta.kind.
    expect(remote).toContain("'kind': 'unprofiled'");
    expect(remote).not.toContain("'meta': None");
    expect(remote).toContain("globals().get('SKIPPED_COLS', set())");
  });

  it("the LOCAL path is unchanged — it reads a mounted file, no egress cost", () => {
    const local = buildSchemaScript("f.parquet", false, false);
    expect(local).not.toContain("SKIPPED_COLS = {c for");
    // ...but it still tolerates the shared tail's lookup.
    expect(local).toContain("globals().get('SKIPPED_COLS', set())");
  });
});

describe("batched profiling passes (perf, verified fidelity-neutral)", () => {
  const script = buildSchemaScript("f.parquet", false, false);

  it("computes per-column aggregates in BATCHED passes, not one query per column", () => {
    // 56 → 23 executed queries on a 10-column fixture (measured in the sandbox
    // image); the sample size is UNCHANGED at 500k and every aggregate
    // expression is the same function over the same rows.
    expect(script).toContain("AGG_BATCH");
    expect(script).toContain("def _agg_specs(ci):");
    expect(script).toContain("def _a(col_name, suffix):");
    expect(script).toContain("OUTLIERS = {}");
  });

  it("keeps percentiles EXACT — no approx_quantile, no list-form PERCENTILE_CONT", () => {
    // approx_quantile is a t-digest estimate, and PERCENTILE_CONT([...]) returns
    // DECIMAL elements as STRINGS — both change what the model sees, so neither
    // is used. Separate exact calls stay.
    expect(script).not.toContain("approx_quantile");
    // Specific enough to not trip on the comment that EXPLAINS why we avoid it.
    expect(script).not.toContain("PERCENTILE_CONT([0");
    expect(script).toContain("PERCENTILE_CONT(0.25) WITHIN GROUP");
    expect(script).toContain("PERCENTILE_CONT(0.75) WITHIN GROUP");
    expect(script).toContain("MEDIAN(");
  });

  it("computes ALL correlation pairs in ONE query, with the original shape", () => {
    // Was one query PER C(n,2) pair, with the top-N cap applied only to the
    // OUTPUT — so every pair scanned regardless. Keys and 4dp rounding are
    // preserved exactly (safe_float would have rounded to 6dp).
    expect(script).toContain("CORR(");
    expect(script).toContain("'pearson': round(float(r), 4)");
    expect(script).toContain("'col_a': col_a");
    expect(script).toContain("MAX_CORRELATION_PAIRS");
  });

  it("takes the sample depth from the caller, defaulting to 50k", () => {
    // SUPERSEDES "500k is deliberate for plan quality". The reason is not cost:
    // on a REMOTE source the sample is `LIMIT n` over the leading row groups, so
    // for a spatially sorted dataset like Overture the extra 450k rows buy a
    // slightly wider slice of the SAME corner — bias that does not shrink with
    // depth (500k of 2.5B is 0.02%). Depth is now a user setting; what makes a
    // shallow default honest is `profile_basis`, not more rows.
    expect(script).toContain("STATS_SAMPLE_SIZE = 50000");
    expect(
      buildRemoteParquetSchemaScript("s3://b/x.parquet", "", false, undefined, 500_000)
    ).toContain("STATS_SAMPLE_SIZE = 500000");
  });

  it("declares the provenance of its statistics (prefix vs random sample)", () => {
    // A prefix over S3 and a local random sample are not interchangeable, and a
    // consumer must be able to tell which produced a range or a distinct count.
    // `script` here is the LOCAL builder: local data is already on the machine,
    // so it takes a genuine random sample.
    expect(script).toContain("PROFILE_BASIS_KIND = 'random_sample'");
    expect(script).toContain("'profile_basis'");
    // A source smaller than the depth was read in full — say so.
    expect(script).toContain("_basis_kind = 'full_scan'");
    // The REMOTE builder cannot: a random sample over S3 egresses everything.
    expect(buildRemoteParquetSchemaScript("s3://b/x.parquet", "", false)).toContain(
      "PROFILE_BASIS_KIND = 'leading_prefix'"
    );
  });
});
