/**
 * Phase 1b-shim integration test (spec §6 / §6-A) — proves the REAL
 * `@duckdb/duckdb-wasm` engine runs an actual SQL query end-to-end through the
 * SYNCHRONOUS `querySync()` path of `createDuckDbBridge`. No mocks: a real
 * DuckDB-WASM instance boots inside the bridge's `node:worker_threads` engine
 * worker, and the caller thread blocks on `SharedArrayBuffer` + `Atomics.wait`
 * until it answers — exactly modeling the Python `duckdb.sql(q).df()` call.
 *
 * The whole point: the calling code contains NO `await`. `querySync` returns a
 * plain value produced by a genuinely asynchronous WASM engine running off-thread.
 *
 * Boot + WASM instantiation happen on the first query, so the timeouts here are
 * generous and the bridge's per-query wall-clock guard is raised to match.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import { createDuckDbBridge } from "@/lib/sandbox/wasm/duckdb-bridge";
import { duckdbEngine } from "@/lib/sandbox/wasm/duckdb-engine";

// First query pays the one-time WASM instantiation cost; give the bridge room.
const BRIDGE_OPTS = { queryTimeoutMs: 60_000 };

// Temp dir for the CSV-reading case (read_csv_auto resolves real paths under NODE_RUNTIME).
const csvDir = mkdtempSync(join(tmpdir(), "hermetic-duckdb-csv-"));
afterAll(() => rmSync(csvDir, { recursive: true, force: true }));

describe("duckdbEngine — real DuckDB-WASM through the synchronous bridge", () => {
  it("runs a real aggregate query synchronously (CREATE TABLE + GROUP BY, NO await)", () => {
    const bridge = createDuckDbBridge(duckdbEngine, BRIDGE_OPTS);
    try {
      // A single SQL string with two statements, exactly like the task spec.
      const result = bridge.querySync(
        "CREATE TABLE t AS SELECT * FROM (VALUES (1,'a'),(2,'b')) tbl(n,label); " +
          "SELECT label, SUM(n) AS total FROM t GROUP BY 1 ORDER BY 1"
      );
      // Not a Promise — a resolved value handed back across the Atomics boundary.
      expect(result).not.toBeInstanceOf(Promise);
      expect(result.columns).toEqual(["label", "total"]);
      expect(result.rows).toEqual([
        ["a", 1],
        ["b", 2],
      ]);
    } finally {
      bridge.dispose();
    }
  }, 90_000);

  it("reads a CSV file end-to-end (NODE_RUNTIME filesystem access) through the bridge", () => {
    // The blocking bundle runs with NODE_RUNTIME, so read_csv_auto resolves real
    // paths. Write a CSV, then parse + aggregate it purely through the SQL seam.
    const csvPath = join(csvDir, "sales.csv");
    writeFileSync(csvPath, "region,amount\nnorth,10\nsouth,25\nnorth,5\n");
    const bridge = createDuckDbBridge(duckdbEngine, BRIDGE_OPTS);
    try {
      const result = bridge.querySync(
        `CREATE TABLE sales AS SELECT * FROM read_csv_auto('${csvPath}'); ` +
          "SELECT region, SUM(amount) AS amount FROM sales GROUP BY 1 ORDER BY region"
      );
      expect(result.columns).toEqual(["region", "amount"]);
      expect(result.rows).toEqual([
        ["north", 15],
        ["south", 25],
      ]);
    } finally {
      bridge.dispose();
    }
  }, 90_000);

  it("is reusable across sequential queries and returns typed scalars", () => {
    const bridge = createDuckDbBridge(duckdbEngine, BRIDGE_OPTS);
    try {
      const a = bridge.querySync("SELECT 6 * 7 AS answer");
      expect(a.rows).toEqual([[42]]);

      // DECIMAL scale is applied; strings and booleans round-trip.
      const b = bridge.querySync("SELECT 3.14::DECIMAL(5,2) AS pi, 'hi' AS greeting, TRUE AS flag");
      expect(b.columns).toEqual(["pi", "greeting", "flag"]);
      expect(b.rows).toEqual([[3.14, "hi", true]]);
    } finally {
      bridge.dispose();
    }
  }, 90_000);

  it("propagates a SQL error as a thrown error from the synchronous call", () => {
    const bridge = createDuckDbBridge(duckdbEngine, BRIDGE_OPTS);
    try {
      expect(() => bridge.querySync("SELECT * FROM no_such_table")).toThrow(/no_such_table/i);
      // The bridge still works after an error (the error path is clean).
      expect(bridge.querySync("SELECT 1 AS one").rows).toEqual([[1]]);
    } finally {
      bridge.dispose();
    }
  }, 90_000);
});
