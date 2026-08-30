import { describe, it, expect } from "vitest";
import { sqlLit } from "@/lib/sandbox/wasm/sql-lit";

/**
 * Every host-side DuckDB query is built from a filesystem path the USER chose,
 * so the escaping has to hold for paths that are legal on disk but hostile to a
 * SQL literal.
 */
describe("sqlLit", () => {
  it("doubles single quotes so a path cannot end the literal early", () => {
    expect(sqlLit("/data/o'brien.parquet")).toBe("/data/o''brien.parquet");
  });

  it("escapes EVERY quote, not just the first", () => {
    expect(sqlLit("a'b'c")).toBe("a''b''c");
  });

  it("neutralizes an attempt to close the literal and append SQL", () => {
    const escaped = sqlLit("/d/x.parquet'); DROP TABLE t; --");
    expect(escaped).toBe("/d/x.parquet''); DROP TABLE t; --");
    // The payload survives as TEXT inside the literal — it never becomes syntax.
    expect(`SELECT '${escaped}'`).toContain("''");
  });

  it("leaves an ordinary path untouched", () => {
    expect(sqlLit("/home/a/data/set/**/*.parquet")).toBe("/home/a/data/set/**/*.parquet");
  });

  it("leaves backslashes alone — DuckDB does not treat them as escapes here", () => {
    // Doubling backslashes would CORRUPT a Windows path; the only metacharacter
    // in a single-quoted DuckDB literal is the quote itself.
    expect(sqlLit("C:\\data\\set.parquet")).toBe("C:\\data\\set.parquet");
  });
});
