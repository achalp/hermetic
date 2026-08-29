import { describe, it, expect } from "vitest";
import { buildWasmPrelude, detectUnsupportedFeatures } from "@/lib/sandbox/wasm/prelude";

describe("buildWasmPrelude — the WASM-safe prelude (spec §5)", () => {
  const prelude = buildWasmPrelude();

  it("KEEPS /data on sys.path so hermetic_runtime imports resolve", () => {
    expect(prelude).toContain('_sys.path.insert(0, "/data")');
    expect(prelude).toContain('if "/data" not in _sys.path:');
  });

  it("KEEPS the json allow_nan patch on both dump and dumps", () => {
    expect(prelude).toContain("_json_mod.dump = _safe_dump");
    expect(prelude).toContain("_json_mod.dumps = _safe_dumps");
    expect(prelude).toContain("kw['allow_nan'] = True");
  });

  it("DROPS every Docker-specific mechanism (spec §5 drop list)", () => {
    // The actual CODE tokens must be gone (the explanatory comment may NAME them,
    // so we assert against executable forms, not bare names): no background
    // threads, cgroup/proc reads, os._exit abort, proxy plumbing, or DuckDB PRAGMAs.
    expect(prelude).not.toContain("threading.Thread");
    expect(prelude).not.toContain("_hb_loop");
    expect(prelude).not.toContain("_mem_watchdog");
    expect(prelude).not.toContain("/sys/fs/cgroup");
    expect(prelude).not.toContain("/proc/self");
    expect(prelude).not.toContain("os._exit(");
    expect(prelude).not.toContain('os.environ.get("HERMETIC_HTTP_PROXY")');
    expect(prelude).not.toContain("SET http_proxy");
    expect(prelude).not.toContain("SET memory_limit");
    expect(prelude).not.toContain("SET temp_directory");
    expect(prelude).not.toContain("SET threads");
  });

  it("carries the leading comment explaining what was dropped and why", () => {
    expect(prelude).toContain("# ── WASM-safe prelude");
    expect(prelude).toMatch(/DROPPED/);
    expect(prelude).toMatch(/KEPT/);
  });

  it("is stable (pure) across calls", () => {
    expect(buildWasmPrelude()).toBe(prelude);
  });
});

describe("detectUnsupportedFeatures — WASM capability pre-check (spec §6)", () => {
  it("returns empty arrays for clean, WASM-compatible code", () => {
    const code = [
      "import pandas as pd",
      "import numpy as np",
      "df = pd.read_csv('/data/input.csv')",
      "import duckdb",
      "duckdb.sql('SELECT * FROM df').df()",
    ].join("\n");
    expect(detectUnsupportedFeatures(code)).toEqual({ imports: [], reasons: [] });
  });

  it("flags a statsmodels import", () => {
    const r = detectUnsupportedFeatures("import statsmodels.api as sm\n");
    expect(r.imports).toEqual(["statsmodels"]);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatch(/statsmodels/);
  });

  it("flags a lifelines import (from-form)", () => {
    const r = detectUnsupportedFeatures("from lifelines import KaplanMeierFitter\n");
    expect(r.imports).toEqual(["lifelines"]);
    expect(r.reasons[0]).toMatch(/lifelines/);
  });

  it("flags a networkx import", () => {
    const r = detectUnsupportedFeatures("import networkx as nx\n");
    expect(r.imports).toEqual(["networkx"]);
    expect(r.reasons[0]).toMatch(/networkx/);
  });

  it("does NOT match a bare mention that is not an import", () => {
    // A comment or string mentioning the name must not route to Docker.
    const r = detectUnsupportedFeatures("# statsmodels would be nice here\nx = 'networkx'\n");
    expect(r).toEqual({ imports: [], reasons: [] });
  });

  it("flags a remote https read_parquet in-worker", () => {
    const r = detectUnsupportedFeatures(
      "df = duckdb.sql(\"SELECT * FROM read_parquet('https://ex.com/a.parquet')\").df()"
    );
    expect(r.imports).toEqual([]);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatch(/remote https Parquet/);
  });

  it("flags an s3:// object-store URL", () => {
    const r = detectUnsupportedFeatures("path = 's3://bucket/key.parquet'");
    expect(r.reasons[0]).toMatch(/object-store/);
  });

  it("flags a gs:// object-store URL (scheme alternation branch)", () => {
    const r = detectUnsupportedFeatures('path = "gs://bucket/key.parquet"');
    expect(r.reasons).toHaveLength(1);
  });

  it("flags an INSTALL httpfs statement (case-insensitive)", () => {
    const r = detectUnsupportedFeatures("duckdb.sql('install HTTPFS')");
    expect(r.reasons[0]).toMatch(/httpfs/);
  });

  it("accumulates multiple distinct findings across imports and remote reads", () => {
    const code = [
      "import statsmodels.api as sm",
      "import lifelines",
      "import networkx as nx",
      "duckdb.sql(\"SELECT * FROM read_parquet('https://ex.com/a.parquet')\")",
      "x = 's3://b/k'",
      "duckdb.sql('INSTALL httpfs')",
    ].join("\n");
    const r = detectUnsupportedFeatures(code);
    expect(r.imports).toEqual(["statsmodels", "lifelines", "networkx"]);
    // three imports + three remote-read reasons
    expect(r.reasons).toHaveLength(6);
  });

  it("a plain local read_parquet is NOT flagged (no remote scheme)", () => {
    const r = detectUnsupportedFeatures("pd.read_parquet('/data/input.parquet')");
    expect(r).toEqual({ imports: [], reasons: [] });
  });
});
