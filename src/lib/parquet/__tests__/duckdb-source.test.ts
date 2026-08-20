import { describe, it, expect } from "vitest";
import {
  parquetReadExpr,
  normalizeRemoteParquetUrl,
  parquetFolderContext,
  parquetFileContext,
  resolveLocalSource,
  resolveRemoteSource,
  isSafeParquetUrl,
  duckdbRemoteAuthSql,
  redactRemoteSecrets,
  applyRemoteAuth,
  remoteAuthSubst,
  S3_KEY_ID_PLACEHOLDER,
  S3_SECRET_PLACEHOLDER,
  DUCKDB_CLOUD_PRELUDE,
  duckdbCloudPreludePy,
} from "@/lib/parquet/duckdb-source";
import type { StoredCSV } from "@/lib/contracts/storage-types";
import type { CSVSchema } from "@/lib/contracts/data-schema";

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

  it("globs a bare remote directory prefix (fixes the reopen-recent 'No files found')", () => {
    // A stored recent URL is a prefix — read_parquet on it 404s as a single object.
    expect(parquetReadExpr("s3://overturemaps-us-west-2/release/x/type=building", true)).toBe(
      "read_parquet('s3://overturemaps-us-west-2/release/x/type=building/**/*.parquet', hive_partitioning=true)"
    );
  });
});

describe("normalizeRemoteParquetUrl", () => {
  it("appends the recursive glob to a bare remote directory prefix", () => {
    expect(normalizeRemoteParquetUrl("s3://b/release/type=building")).toBe(
      "s3://b/release/type=building/**/*.parquet"
    );
    expect(normalizeRemoteParquetUrl("s3://b/dir/")).toBe("s3://b/dir/**/*.parquet");
  });
  it("leaves explicit files, existing globs, and local paths untouched", () => {
    expect(normalizeRemoteParquetUrl("s3://b/f.parquet")).toBe("s3://b/f.parquet");
    expect(normalizeRemoteParquetUrl("s3://b/**/*.parquet")).toBe("s3://b/**/*.parquet");
    expect(normalizeRemoteParquetUrl("/local/dir")).toBe("/local/dir");
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
  it("folder context creates a view and includes the large-data warning + scan strategy past 1M rows", () => {
    const ctx = parquetFolderContext("read_parquet('s3://bkt/**/*.parquet')", 5_000_000, false);
    expect(ctx).toContain(
      "CREATE OR REPLACE VIEW data AS SELECT * FROM read_parquet('s3://bkt/**/*.parquet')"
    );
    expect(ctx).toContain("large dataset");
    expect(ctx).not.toContain("Hive-partitioned");
    // Classify-first scan strategy (geo + non-geo), with the metadata path
    // pulled from the read expression.
    expect(ctx).toContain("SCAN STRATEGY");
    expect(ctx).toContain("EXTREME / SELECTIVE");
    expect(ctx).toContain("METADATA-ONLY AGGREGATE");
    expect(ctx).toContain("HOLISTIC AGGREGATE");
    expect(ctx).toContain("parquet_metadata('s3://bkt/**/*.parquet')");
  });

  it("folder context omits the large-data warning AND scan strategy under 1M rows", () => {
    const ctx = parquetFolderContext("read_parquet('X', hive_partitioning=true)", 1000, true);
    expect(ctx).not.toContain("large dataset");
    expect(ctx).not.toContain("SCAN STRATEGY");
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

  it("rejects SSRF targets: metadata endpoint, loopback, private ranges", () => {
    expect(isSafeParquetUrl("https://169.254.169.254/latest/meta-data/x.parquet")).toBe(false);
    expect(isSafeParquetUrl("http://metadata.google.internal/x.parquet")).toBe(false);
    expect(isSafeParquetUrl("https://localhost:3000/x.parquet")).toBe(false);
    expect(isSafeParquetUrl("https://127.0.0.1/x.parquet")).toBe(false);
    expect(isSafeParquetUrl("http://10.0.0.5/x.parquet")).toBe(false);
    expect(isSafeParquetUrl("http://172.16.0.1/x.parquet")).toBe(false);
    expect(isSafeParquetUrl("http://192.168.1.1/x.parquet")).toBe(false);
    expect(isSafeParquetUrl("http://100.64.0.1/x.parquet")).toBe(false); // CGNAT
    expect(isSafeParquetUrl("http://[::1]/x.parquet")).toBe(false); // IPv6 literal
    expect(isSafeParquetUrl("http://2130706433/x.parquet")).toBe(false); // decimal 127.0.0.1
    expect(isSafeParquetUrl("http://svc.cluster.internal/x.parquet")).toBe(false);
  });

  it("rejects shorthand / hex / octal IPv4 encodings of internal addresses (finding H2)", () => {
    // All of these resolve to 127.0.0.1 via inet_aton — the old 4-group regex
    // let them through.
    expect(isSafeParquetUrl("http://127.1/x.parquet")).toBe(false); // 2-part shorthand
    expect(isSafeParquetUrl("http://0x7f000001/x.parquet")).toBe(false); // hex integer
    expect(isSafeParquetUrl("http://0177.0.0.1/x.parquet")).toBe(false); // octal first octet
    expect(isSafeParquetUrl("http://127.0.1/x.parquet")).toBe(false); // 3-part shorthand
    expect(isSafeParquetUrl("http://0x7f.1/x.parquet")).toBe(false); // hex + shorthand
    // metadata endpoint 169.254.169.254 as a single integer.
    expect(isSafeParquetUrl("http://2852039166/x.parquet")).toBe(false);
    // RFC-1918 10.0.0.5 in 2-part shorthand (10.5).
    expect(isSafeParquetUrl("http://10.5/x.parquet")).toBe(false);
  });

  it("still accepts public https hosts and object-store bucket schemes", () => {
    expect(isSafeParquetUrl("https://data.example.com/x.parquet")).toBe(true);
    expect(isSafeParquetUrl("https://172.200.1.1/x.parquet")).toBe(true); // public IP (172 outside 16-31)
    expect(isSafeParquetUrl("http://0x08080808/x.parquet")).toBe(true); // hex 8.8.8.8 (public)
    expect(isSafeParquetUrl("http://8.8.8.8/x.parquet")).toBe(true); // public IP
    // s3:// names a bucket, not a network host — always resolves at AWS.
    expect(isSafeParquetUrl("s3://10.0.0.5/x.parquet")).toBe(true);
  });
});

describe("duckdbRemoteAuthSql", () => {
  it("is empty for anonymous access (no creds, or region-less)", () => {
    expect(duckdbRemoteAuthSql()).toBe("");
    expect(duckdbRemoteAuthSql({})).toBe("");
  });

  it("emits only a region SET when just a region is given", () => {
    expect(duckdbRemoteAuthSql({ s3Region: "us-west-2" })).toBe("SET s3_region='us-west-2';");
  });

  it("creates an S3 secret with key + secret (+ optional region/endpoint)", () => {
    const sql = duckdbRemoteAuthSql({
      s3AccessKeyId: "AKIA123",
      s3SecretAccessKey: "shhh",
      s3Region: "eu-west-1",
      s3Endpoint: "minio.local",
    });
    expect(sql).toContain("CREATE OR REPLACE SECRET hermetic_s3");
    expect(sql).toContain("TYPE s3");
    expect(sql).toContain("KEY_ID 'AKIA123'");
    expect(sql).toContain("SECRET 'shhh'");
    expect(sql).toContain("REGION 'eu-west-1'");
    expect(sql).toContain("ENDPOINT 'minio.local'");
  });

  it("rejects (drops to anonymous) any credential that could break the SQL literal", () => {
    expect(duckdbRemoteAuthSql({ s3AccessKeyId: "k'; DROP", s3SecretAccessKey: "s" })).toBe("");
    expect(duckdbRemoteAuthSql({ s3Region: "us-west-2'; --" })).toBe("");
  });

  it("emits PLACEHOLDER key/secret (not the real values) when placeholders=true (C1)", () => {
    const sql = duckdbRemoteAuthSql(
      { s3AccessKeyId: "AKIAREAL", s3SecretAccessKey: "topsecret", s3Region: "eu-west-1" },
      true
    );
    expect(sql).toContain(`KEY_ID '${S3_KEY_ID_PLACEHOLDER}'`);
    expect(sql).toContain(`SECRET '${S3_SECRET_PLACEHOLDER}'`);
    expect(sql).not.toContain("AKIAREAL");
    expect(sql).not.toContain("topsecret");
    // Region is not a secret — it stays real so the model reads the right bucket.
    expect(sql).toContain("REGION 'eu-west-1'");
  });
});

describe("remote credential isolation from the prompt (finding C1)", () => {
  const creds = { s3AccessKeyId: "AKIAREAL", s3SecretAccessKey: "topsecret" };

  it("keeps the real key/secret OUT of resolveRemoteSource's prompt context", () => {
    const { localFileContext, remoteAuthSubst: subst } = resolveRemoteSource(
      "s3://bucket/data/*.parquet",
      1000,
      false,
      creds
    );
    // The prompt (localFileContext) is what reaches the (possibly remote) model.
    expect(localFileContext).not.toContain("AKIAREAL");
    expect(localFileContext).not.toContain("topsecret");
    expect(localFileContext).toContain(S3_KEY_ID_PLACEHOLDER);
    expect(localFileContext).toContain(S3_SECRET_PLACEHOLDER);
    // The real values ride alongside for the executor boundary only.
    expect(subst).toEqual({ keyId: "AKIAREAL", secret: "topsecret" });
  });

  it("applyRemoteAuth restores real creds into the executed code", () => {
    const code = `duckdb.sql("CREATE OR REPLACE SECRET hermetic_s3 (TYPE s3, KEY_ID '${S3_KEY_ID_PLACEHOLDER}', SECRET '${S3_SECRET_PLACEHOLDER}');")`;
    const subst = remoteAuthSubst(creds);
    const executed = applyRemoteAuth(code, subst);
    expect(executed).toContain("KEY_ID 'AKIAREAL'");
    expect(executed).toContain("SECRET 'topsecret'");
    expect(executed).not.toContain(S3_KEY_ID_PLACEHOLDER);
    expect(executed).not.toContain(S3_SECRET_PLACEHOLDER);
  });

  it("applyRemoteAuth is a no-op without a substitution (local/anonymous)", () => {
    const code = "print('hello')";
    expect(applyRemoteAuth(code, undefined)).toBe(code);
  });

  it("remoteAuthSubst is undefined for anonymous or unsafe creds", () => {
    expect(remoteAuthSubst(undefined)).toBeUndefined();
    expect(remoteAuthSubst({ s3Region: "us-west-2" })).toBeUndefined();
    expect(remoteAuthSubst({ s3AccessKeyId: "k'; DROP", s3SecretAccessKey: "s" })).toBeUndefined();
  });

  it("redactRemoteSecrets still scrubs the placeholder line for logs", () => {
    const code = `KEY_ID '${S3_KEY_ID_PLACEHOLDER}', SECRET '${S3_SECRET_PLACEHOLDER}'`;
    expect(redactRemoteSecrets(code)).toBe("KEY_ID '[redacted]', SECRET '[redacted]'");
  });
});

describe("resolveRemoteSource", () => {
  it("uses single-file guidance for a single remote .parquet", () => {
    const { localFileContext } = resolveRemoteSource("s3://bucket/data/x.parquet", 10_000);
    expect(localFileContext).toContain(DUCKDB_CLOUD_PRELUDE);
    expect(localFileContext).toContain("read_parquet('s3://bucket/data/x.parquet')");
    expect(localFileContext).toContain("This is a Parquet file at");
    // Anonymous: no authenticate line.
    expect(localFileContext).not.toContain("authenticate");
  });

  it("uses folder guidance (create a view, materialize a subset) for a glob", () => {
    const { localFileContext } = resolveRemoteSource("s3://bucket/data/*.parquet", 2_500_000_000);
    expect(localFileContext).toContain("folder of Parquet files");
    expect(localFileContext).toContain(
      "CREATE OR REPLACE VIEW data AS SELECT * FROM read_parquet('s3://bucket/data/*.parquet')"
    );
    expect(localFileContext).toContain("Total rows: 2,500,000,000.");
    // Large-data guidance carries through for a huge remote dataset.
    expect(localFileContext).toContain("large dataset");
  });

  it("steers a numeric-only KD-tree frame and LOCAL rowid hydration for a bounded region", () => {
    const { localFileContext } = resolveRemoteSource("s3://bucket/data/*.parquet", 2_500_000_000);
    expect(localFileContext).toContain("NETWORK COST");
    expect(localFileContext).toContain("CREATE TEMP TABLE t AS SELECT");
    // Cost scales with columns × rows; the KD-tree frame is numeric-only.
    expect(localFileContext).toContain("COLUMNS × ROWS");
    expect(localFileContext).toContain("SELECT rowid, lon, lat FROM t");
    // The fix: a bounded region hydrates the winners LOCALLY by rowid — a
    // second remote bbox read to hydrate a most-isolated top-N is the trap
    // that timed out California (winners sit in wide-span row groups).
    expect(localFileContext).toContain("hydrate the winners");
    expect(localFileContext).toContain("WHERE rowid IN");
    expect(localFileContext).toContain("WIDE-SPAN row groups");
  });

  it("adds the hive_partitioning flag and partition-column note for a Hive dataset", () => {
    const { localFileContext } = resolveRemoteSource(
      "s3://overturemaps-us-west-2/release/2026-06-17.0/theme=buildings/type=building/**/*.parquet",
      2_500_000_000,
      true
    );
    expect(localFileContext).toContain("hive_partitioning=true");
    expect(localFileContext).toContain("Partition columns");
  });

  it("includes an authenticate step when credentials are supplied", () => {
    const { localFileContext } = resolveRemoteSource("s3://bucket/x.parquet", 1000, false, {
      s3AccessKeyId: "AKIA123",
      s3SecretAccessKey: "shhh",
    });
    expect(localFileContext).toContain("authenticate");
    expect(localFileContext).toContain("CREATE OR REPLACE SECRET hermetic_s3");
  });
});

describe("redactRemoteSecrets (finding M1)", () => {
  it("redacts KEY_ID and SECRET literal values from a generated script", () => {
    const authSql = duckdbRemoteAuthSql({
      s3AccessKeyId: "AKIAIOSFODNN7EXAMPLE",
      s3SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      s3Region: "us-west-2",
    });
    const code = `import duckdb\nduckdb.sql("${authSql}")\nduckdb.sql("SELECT * FROM read_parquet('s3://b/x.parquet')")`;

    const redacted = redactRemoteSecrets(code);

    // The credential VALUES are gone…
    expect(redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redacted).not.toContain("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    // …replaced by a placeholder, while the structure stays readable.
    expect(redacted).toContain("KEY_ID '[redacted]'");
    expect(redacted).toContain("SECRET '[redacted]'");
    // Non-secret context is untouched — the SECRET keyword in the statement name
    // and the region literal survive.
    expect(redacted).toContain("CREATE OR REPLACE SECRET hermetic_s3");
    expect(redacted).toContain("us-west-2");
  });

  it("is a no-op for a script with no embedded secret", () => {
    const code = `duckdb.sql("SELECT * FROM read_parquet('s3://public/x.parquet')").df()`;
    expect(redactRemoteSecrets(code)).toBe(code);
  });
});
