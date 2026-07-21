import { describe, it, expect } from "vitest";
import { friendlyParquetError } from "@/lib/parquet/friendly-error";

describe("friendlyParquetError", () => {
  it("translates 'No files found' into an actionable message (the reopen-recent case)", () => {
    const raw =
      'Traceback (most recent call last):\n  File "/data/script.py", line 455, in <module>\n' +
      "    describe = con.sql(...).fetchall()\n" +
      'duckdb.duckdb.IOException: IO Error: No files found that match the pattern "s3://b/type=building/**/*.parquet"';
    const msg = friendlyParquetError(raw);
    expect(msg).toMatch(/no Parquet files were found/i);
    expect(msg).not.toMatch(/Traceback|duckdb\.duckdb|line 455/); // no raw stack
  });

  it("maps 404, access-denied, and connection failures", () => {
    expect(friendlyParquetError("HTTPException: HTTP Error: 404 (Not Found)")).toMatch(/404/);
    expect(friendlyParquetError("S3 Error: Access Denied")).toMatch(/access was denied/i);
    expect(friendlyParquetError("IO Error: Unable to connect to URL")).toMatch(
      /couldn't reach the remote host/i
    );
    expect(friendlyParquetError("Invalid Input Error: No magic bytes found")).toMatch(
      /different format or corrupted/i
    );
  });

  it("for an unknown error, surfaces the exception message, not the whole traceback", () => {
    const raw =
      'Traceback (most recent call last):\n  File "/data/script.py", line 12\n' +
      "duckdb.duckdb.SomeWeirdException: something specific went wrong here";
    const msg = friendlyParquetError(raw);
    expect(msg).toContain("something specific went wrong here");
    expect(msg).not.toMatch(/Traceback|line 12/);
  });

  it("never returns an empty message", () => {
    expect(friendlyParquetError("").length).toBeGreaterThan(0);
    expect(friendlyParquetError("garbage with no exception").length).toBeGreaterThan(0);
  });
});
