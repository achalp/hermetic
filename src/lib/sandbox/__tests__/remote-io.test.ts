import { describe, it, expect } from "vitest";
import { codeDoesRemoteIo, codeNeedsNetwork } from "@/lib/sandbox/docker-utils";

describe("codeDoesRemoteIo", () => {
  it("flags DuckDB httpfs cloud reads (needs the extended timeout)", () => {
    expect(
      codeDoesRemoteIo('duckdb.sql("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial;")')
    ).toBe(true);
    expect(
      codeDoesRemoteIo("duckdb.sql(\"SELECT * FROM read_parquet('s3://bucket/x/*.parquet')\")")
    ).toBe(true);
    expect(codeDoesRemoteIo("read_parquet('https://host/data/file.parquet')")).toBe(true);
    expect(codeDoesRemoteIo("read_parquet('gs://bucket/x.parquet')")).toBe(true);
  });

  it("does not flag local/in-container reads (default timeout is fine)", () => {
    expect(codeDoesRemoteIo("pd.read_csv('/data/input.csv')")).toBe(false);
    expect(
      codeDoesRemoteIo("duckdb.sql(\"SELECT * FROM read_parquet('/data/local/x.parquet')\")")
    ).toBe(false);
    // A results dict that merely mentions an http URL string is not a cloud read.
    expect(codeDoesRemoteIo('results = {"link": "http://example.com/page"}')).toBe(false);
  });
});

describe("codeNeedsNetwork (gates --network none)", () => {
  it("is a superset of codeDoesRemoteIo", () => {
    expect(codeNeedsNetwork("read_parquet('s3://bucket/x.parquet')")).toBe(true);
    expect(codeNeedsNetwork('duckdb.sql("INSTALL httpfs; LOAD httpfs;")')).toBe(true);
  });

  it("flags generic URL fetches and network libraries that codeDoesRemoteIo ignores", () => {
    // Deliberately permissive: a missed network need is a hard failure, a
    // false positive only loses the no-network hardening for one run.
    expect(codeNeedsNetwork("df = pd.read_csv('https://example.com/data.csv')")).toBe(true);
    expect(codeNeedsNetwork('results = {"link": "http://example.com/page"}')).toBe(true);
    expect(codeNeedsNetwork("import requests\nrequests.get(url)")).toBe(true);
    expect(codeNeedsNetwork("from urllib.request import urlopen")).toBe(true);
  });

  it("does not flag pure local analyses (these run under --network none)", () => {
    expect(codeNeedsNetwork("pd.read_csv('/data/input.csv')")).toBe(false);
    // Pre-bundled extension INSTALL/LOAD works offline in the sandbox image.
    expect(codeNeedsNetwork('duckdb.sql("INSTALL spatial; LOAD spatial;")')).toBe(false);
    expect(codeNeedsNetwork("read_parquet('/data/local/x.parquet')")).toBe(false);
  });
});
