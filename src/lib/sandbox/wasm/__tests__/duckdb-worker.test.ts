import { describe, it, expect } from "vitest";
import {
  DUCKDB_BOOT_FN_SOURCE,
  codeNeedsDuckDb,
  DUCKDB_PY_SHIM,
  DUCKDB_BUNDLE_FILE,
  DUCKDB_WASM_FILE,
} from "@/lib/sandbox/wasm/duckdb-worker";

/**
 * The worker-side DuckDB seam (build log D18). These pin the properties that make
 * it work under the sandbox CSP — every one of them was a failure mode the spike
 * actually hit, so a regression here is a regression to a known-broken state.
 */

const src = DUCKDB_BOOT_FN_SOURCE;

describe("DUCKDB_BOOT_FN_SOURCE — CSP-compatible asset loading", () => {
  it("loads the classic-worker bundle and the mvp module from the caller-supplied base", () => {
    expect(src).toContain(`importScripts(base + "${DUCKDB_BUNDLE_FILE}")`);
    expect(src).toContain(DUCKDB_WASM_FILE);
    // The eh module traps against the blocking glue (call_indirect signature
    // mismatch, measured in D18) — it must never be offered as a bundle.
    expect(src).not.toContain("duckdb-eh.wasm");
  });

  it("points BOTH extension repository settings at the local repo, never the CDN", () => {
    expect(src).toContain("SET custom_extension_repository=");
    expect(src).toContain("SET autoinstall_extension_repository=");
    // connect-src 'self' blocks this host; relying on it is the D18 failure.
    expect(src).not.toContain("extensions.duckdb.org");
  });

  it("uses directIO=true so httpfs range-reads instead of buffering whole objects", () => {
    // 4th arg of registerFileURL; false buffers the entire file (D18: 525MB / 14.5s).
    expect(src).toContain("duck.DuckDBDataProtocol.HTTP, true)");
  });
});

describe("codeNeedsDuckDb — booting a 41MB engine must be opt-in", () => {
  it("is true only for a real duckdb import", () => {
    expect(codeNeedsDuckDb("import duckdb")).toBe(true);
    expect(codeNeedsDuckDb("import duckdb as ddb\nx=1")).toBe(true);
    expect(codeNeedsDuckDb("from duckdb import sql")).toBe(true);
  });
  it("is false for pandas-only code, and for mere mentions", () => {
    expect(codeNeedsDuckDb("import pandas as pd")).toBe(false);
    expect(codeNeedsDuckDb("# duckdb would be nice here")).toBe(false);
    expect(codeNeedsDuckDb('df.to_csv("duckdb.csv")')).toBe(false);
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
