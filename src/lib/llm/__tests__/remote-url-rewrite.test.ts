import { describe, it, expect } from "vitest";
import {
  postProcessGeneratedCode,
  fixUpFilenames,
  fixReadCsvDelimiter,
} from "@/lib/llm/code-generation";

/**
 * Regression suite for run 5f8b7787: Hermetic corrupted its own generated code.
 *
 * `fixUpFilenames` replaced `/data/<schema.filename>` with `/data/input.csv`
 * GLOBALLY and unanchored. For a remote source `schema.filename` is the object's
 * basename, so any URL whose path contains a `/data/` segment had its own path
 * rewritten — pointing the analysis at an object that does not exist. The model
 * emitted the correct URL on all four attempts; this rewrote it on all four, which
 * is why the retries produced byte-identical 404s for 13 minutes and $2.52.
 *
 * The matrix below is the audit that found it. Every scheme is included on purpose:
 * s3/gs/az were hit exactly as hard as https, so pinning only the reported https
 * case would leave three-quarters of the bug in place.
 */

const schema = (filename: string) => ({ filename, columns: [{ name: "year" }] });
const prog = (url: string) =>
  ["import duckdb", `df = duckdb.sql("SELECT * FROM read_parquet('${url}')").df()`].join("\n");

/** `filenameFromUrl` in the schema route: the last path segment. */
const basename = (url: string) => url.split("?")[0]!.split("/").filter(Boolean).pop()!;

describe("remote URLs survive post-processing (the D32 matrix)", () => {
  const REMOTE = [
    // The reported case.
    "https://ahihubpublic.blob.core.windows.net/data/housing-landscape.parquet",
    // Same shape, every other scheme — the reason this is a matrix and not one test.
    "s3://my-bucket/data/housing-landscape.parquet",
    "gs://my-bucket/data/housing-landscape.parquet",
    "az://container/data/housing-landscape.parquet",
    // `/data/` need not be the FIRST segment.
    "s3://bucket/warehouse/data/facts.parquet",
    "https://host.example.com/v1/data/export.parquet",
    // Globs.
    "s3://bucket/data/*.parquet",
    "s3://bucket/data/**/*.parquet",
    // An object legitimately named with a doubled extension.
    "s3://bucket/data/input.csv.csv",
    // A remote CSV read through the same path.
    "https://host/data/report.csv",
    // Controls: no `/data/` segment (these were never broken — keep them that way).
    "s3://bucket/warehouse/housing-landscape.parquet",
    "https://host.example.com/exports/housing-landscape.parquet",
  ];

  for (const url of REMOTE) {
    it(`leaves ${url} byte-identical`, () => {
      // Byte-identical is the real property, and it is stronger than "contains
      // the url": a substring check passes for `/data/input.csv.csv`, whose own
      // name contains the very string the bug rewrites to.
      const out = postProcessGeneratedCode(prog(url), schema(basename(url)), {
        hasDataLocation: true,
      });
      expect(out).toBe(prog(url));
    });
  }

  it("is safe even with the Data Location gate OFF — the URL guard is independent", () => {
    // Defense in depth: fixUpFilenames is exported and directly reachable, so the
    // guard must hold without the caller remembering to pass the flag.
    const url = "s3://my-bucket/data/housing-landscape.parquet";
    expect(fixUpFilenames(prog(url), "housing-landscape.parquet")).toContain(url);
  });

  it("never rewrites a non-CSV sandbox path to a .csv one", () => {
    // `/data/input.parquet` is a real delivery path (a materialized warehouse
    // pull). Pointing it at input.csv is wrong under any premise.
    const code = `duckdb.sql("SELECT * FROM read_parquet('/data/input.parquet')")`;
    expect(fixUpFilenames(code, "input.parquet")).toContain("/data/input.parquet");
  });
});

describe("the local-upload repair it exists for still works", () => {
  it("rewrites /data/<original>.csv to the delivered /data/input.csv", () => {
    const code = `df = pd.read_csv("/data/sales.csv")`;
    const out = postProcessGeneratedCode(code, schema("sales.csv"), { hasDataLocation: false });
    expect(out).toContain("/data/input.csv");
    expect(out).not.toContain("/data/sales.csv");
  });

  it("collapses a doubled extension on a LOCAL path", () => {
    expect(fixUpFilenames(`pd.read_csv("/data/input.csv.csv")`, "input.csv")).toContain(
      `"/data/input.csv"`
    );
  });

  it("is SKIPPED entirely on a Data Location run", () => {
    // The prompt already tells the model Data Location overrides every default;
    // the repairs used to override the override.
    const code = `df = pd.read_csv("/data/sales.csv")`;
    expect(
      postProcessGeneratedCode(code, schema("sales.csv"), { hasDataLocation: true })
    ).toContain("/data/sales.csv");
  });
});

describe("fixReadCsvDelimiter must not assume commas about a REMOTE file", () => {
  it("leaves a remote read_csv alone — a .tsv is not ours to reinterpret", () => {
    // Forcing delimiter=',' overrides DuckDB's auto-detection and parses the whole
    // file into ONE column: a silent wrong answer, not a crash.
    for (const u of ["s3://b/exports/f.tsv", "https://h/d/f.csv", "gs://b/f.psv"]) {
      const code = `duckdb.sql("SELECT * FROM read_csv('${u}')")`;
      expect(fixReadCsvDelimiter(code)).toBe(code);
    }
  });

  it("still fixes the LOCAL delivered CSV, which is comma-separated by construction", () => {
    expect(fixReadCsvDelimiter(`read_csv('/data/input.csv')`)).toBe(
      `read_csv('/data/input.csv', delimiter=',')`
    );
  });

  it("never double-adds a delimiter that is already there", () => {
    const code = `read_csv('/data/input.csv', delimiter='\\t')`;
    expect(fixReadCsvDelimiter(code)).toBe(code);
  });
});
