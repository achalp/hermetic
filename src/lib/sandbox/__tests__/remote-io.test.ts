import { describe, it, expect } from "vitest";
import { codeDoesRemoteIo } from "@/lib/sandbox/docker-utils";

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
