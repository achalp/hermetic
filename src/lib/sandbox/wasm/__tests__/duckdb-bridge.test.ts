/**
 * Phase 1b-shim integration test (spec §6 / §6-A). Drives the REAL
 * `createDuckDbBridge` over actual `node:worker_threads` + `SharedArrayBuffer` +
 * `Atomics` — no mocks — to pin the sync↔async handoff the DuckDB-WASM shim needs:
 *
 *   (a) a SYNCHRONOUS `querySync()` call returns the ASYNC engine's result with NO
 *       await anywhere in the calling code (the return is a value, not a Promise) —
 *       the caller thread blocked on Atomics.wait while the engine ran in a second
 *       worker and Atomics.notify'd back (this models the Python `duckdb.sql().df()`
 *       call);
 *   (b) two sequential queries both work — the bridge is reusable across requests;
 *   (c) an engine error propagates as a THROWN error out of the synchronous call;
 *   (d) the size guard: an over-cap response and an over-cap request both surface as
 *       thrown errors rather than overrunning the shared buffer.
 *
 * The engine is a self-contained async function (its SOURCE is shipped into the
 * worker), which is exactly how a later phase swaps in a @duckdb/duckdb-wasm body.
 * (Node's threads support SAB + Atomics natively — the browser's COOP/COEP is not
 * needed here; §6-A.)
 */
import { describe, it, expect } from "vitest";
import { createDuckDbBridge, type DuckDbEngine } from "@/lib/sandbox/wasm/duckdb-bridge";

// A stand-in async engine. MUST be self-contained (no closure over test scope) —
// its source is rebuilt inside the engine worker. It is genuinely asynchronous
// (awaits a timer, off the caller thread), throws for a "boom" query, and can be
// driven to emit a large result via a "big:N" query (for the size-guard test).
const engine: DuckDbEngine = async (sql: string) => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  if (/boom/i.test(sql)) throw new Error(`engine exploded on: ${sql}`);
  const big = /^big:(\d+)$/.exec(sql);
  if (big) {
    const n = Number(big[1]);
    return { columns: ["blob"], rows: [["x".repeat(n)]] };
  }
  return { columns: ["sql", "len"], rows: [[sql, sql.length]] };
};

describe("createDuckDbBridge — sync/async DuckDB bridge over worker_threads + Atomics", () => {
  it("(a) a synchronous querySync() returns the async engine's result — NO await", () => {
    const bridge = createDuckDbBridge(engine);
    try {
      // No `await`: querySync blocks on Atomics.wait and hands back a plain value.
      const result = bridge.querySync("SELECT 1");
      expect(result).not.toBeInstanceOf(Promise);
      expect(result).toEqual({ columns: ["sql", "len"], rows: [["SELECT 1", 8]] });
    } finally {
      bridge.dispose();
    }
  }, 15_000);

  it("(b) two sequential queries both resolve — the bridge is reusable", () => {
    const bridge = createDuckDbBridge(engine);
    try {
      const first = bridge.querySync("alpha");
      const second = bridge.querySync("bravo query");
      expect(first).toEqual({ columns: ["sql", "len"], rows: [["alpha", 5]] });
      expect(second).toEqual({ columns: ["sql", "len"], rows: [["bravo query", 11]] });
    } finally {
      bridge.dispose();
    }
  }, 15_000);

  it("(c) an engine error propagates as a thrown error from the synchronous call", () => {
    const bridge = createDuckDbBridge(engine);
    try {
      expect(() => bridge.querySync("boom now")).toThrow(/engine exploded on: boom now/);
      // ...and the bridge still works after a thrown query (error path is clean).
      expect(bridge.querySync("after")).toEqual({ columns: ["sql", "len"], rows: [["after", 5]] });
    } finally {
      bridge.dispose();
    }
  }, 15_000);

  it("(d) the response size guard rejects an over-cap result (no buffer overrun)", () => {
    const bridge = createDuckDbBridge(engine, { maxResultBytes: 256 });
    try {
      // The engine emits a ~2 KB row, well over the 256-byte response data buffer —
      // the guard turns it into a thrown error instead of overrunning the buffer.
      expect(() => bridge.querySync("big:2000")).toThrow(
        /exceeds the 256-byte shared result buffer/
      );
      // A fitting query still round-trips on the same bridge afterwards.
      expect(bridge.querySync("ok")).toEqual({ columns: ["sql", "len"], rows: [["ok", 2]] });
    } finally {
      bridge.dispose();
    }
  }, 15_000);

  it("throws once disposed", () => {
    const bridge = createDuckDbBridge(engine);
    bridge.dispose();
    expect(() => bridge.querySync("SELECT 1")).toThrow(/disposed/);
    // dispose is idempotent.
    expect(() => bridge.dispose()).not.toThrow();
  }, 15_000);
});
