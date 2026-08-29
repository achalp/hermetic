import { describe, it, expect } from "vitest";
import {
  duckdbBootSource,
  DUCKDB_PY_SHIM,
  DUCKDB_BUNDLE_FILE,
  DUCKDB_WASM_FILE,
} from "@/lib/sandbox/wasm/duckdb-worker";

/**
 * The worker-side DuckDB seam (build log D18). These pin the properties that make
 * it work under the sandbox CSP — every one of them was a failure mode the spike
 * actually hit, so a regression here is a regression to a known-broken state.
 */

const BASE = "/duckdb/";

describe("duckdbBootSource — CSP-compatible asset loading", () => {
  it("loads the classic-worker bundle and the mvp module from the same-origin base", () => {
    const src = duckdbBootSource(BASE, []);
    expect(src).toContain(`importScripts("/duckdb/" + "${DUCKDB_BUNDLE_FILE}")`);
    expect(src).toContain(DUCKDB_WASM_FILE);
    // The eh module traps against the blocking glue (call_indirect signature
    // mismatch, measured in D18) — it must never be offered as a bundle.
    expect(src).not.toContain("duckdb-eh.wasm");
  });

  it("points BOTH extension repository settings at the local repo, never the CDN", () => {
    const src = duckdbBootSource(BASE, []);
    expect(src).toContain("SET custom_extension_repository=");
    expect(src).toContain("SET autoinstall_extension_repository=");
    // connect-src 'self' blocks this host; relying on it is the D18 failure.
    expect(src).not.toContain("extensions.duckdb.org");
  });

  it("always loads parquet; loads httpfs ONLY when a remote source is registered", () => {
    const local = duckdbBootSource(BASE, []);
    expect(local).toContain("INSTALL parquet");
    expect(local).not.toContain("INSTALL httpfs");

    const remote = duckdbBootSource(BASE, [{ name: "src.parquet", url: "/api/wasm-range/tok-1" }]);
    expect(remote).toContain("INSTALL httpfs");
    expect(remote).toContain("registerFileURL");
  });

  it("registers remote sources under an ALIAS bound to the token URL — never the upstream", () => {
    const src = duckdbBootSource(BASE, [
      { name: "buildings.parquet", url: "/api/wasm-range/tok-1" },
    ]);
    expect(src).toContain("buildings.parquet");
    expect(src).toContain("/api/wasm-range/tok-1");
    // The real object store URL is resolved host-side and must not reach the worker.
    expect(src).not.toContain("s3://");
    expect(src).not.toContain("amazonaws.com");
  });

  it("uses directIO=true so httpfs range-reads instead of buffering whole objects", () => {
    const src = duckdbBootSource(BASE, [{ name: "a.parquet", url: "/api/wasm-range/t" }]);
    // 4th arg of registerFileURL; false buffers the entire file (D18: 525MB / 14.5s).
    expect(src).toContain("_duck.DuckDBDataProtocol.HTTP, true)");
  });
});

describe("DUCKDB_PY_SHIM — the surface generated code actually calls", () => {
  it("installs a real `duckdb` module so `import duckdb` resolves", () => {
    expect(DUCKDB_PY_SHIM).toContain('_sys.modules["duckdb"] = _duckdb');
  });

  it("exposes sql/query/execute and connect()", () => {
    for (const fn of ["_duckdb.sql", "_duckdb.query", "_duckdb.execute", "_duckdb.connect"]) {
      expect(DUCKDB_PY_SHIM).toContain(fn);
    }
  });

  it("results support df()/to_df()/fetchall()/fetchone() — the documented contract", () => {
    for (const m of ["def df(", "to_df = df", "def fetchall(", "def fetchone("]) {
      expect(DUCKDB_PY_SHIM).toContain(m);
    }
  });

  it("parses the engine's JSON rendering, which is what .toString() actually returns", () => {
    // Verified against the real engine: rows come back as a JSON array of objects,
    // and an empty result set is whitespace-only brackets.
    const rows = `[\n  {"a": 1, "b": "x"},\n  {"a": 2, "b": "y"}\n]`;
    expect(JSON.parse(rows)).toEqual([
      { a: 1, b: "x" },
      { a: 2, b: "y" },
    ]);
    expect(JSON.parse(`[\n  \n]`)).toEqual([]);
    expect(DUCKDB_PY_SHIM).toContain("_json.loads(raw)");
  });
});
