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

  it("does NOT flag LOAD/INSTALL of vendored extensions (parquet, spatial)", () => {
    const code =
      "duckdb.sql('LOAD spatial')\nduckdb.sql('INSTALL parquet')\nduckdb.sql('LOAD parquet')";
    expect(detectUnsupportedFeatures(code)).toEqual({ imports: [], reasons: [] });
  });

  it("flags LOAD of a non-vendored DuckDB extension (the anonymous _setThrew trap, run 9cb7770b)", () => {
    const r = detectUnsupportedFeatures("duckdb.sql('LOAD icu')");
    expect(r.imports).toEqual([]);
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatch(/'icu'/);
    expect(r.reasons[0]).toMatch(/route to Docker/);
  });

  it("flags INSTALL of a non-vendored extension once, deduping the LOAD of the same name", () => {
    const r = detectUnsupportedFeatures("duckdb.sql('INSTALL h3')\nduckdb.sql('LOAD h3')");
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatch(/'h3'/);
  });

  it("does NOT false-flag lowercase prose like '# load data' (keywords are case-sensitive)", () => {
    const r = detectUnsupportedFeatures("# load data from parquet\n# then install deps\nx = 1");
    expect(r).toEqual({ imports: [], reasons: [] });
  });
});

describe("parity additions (2026-09 audit)", () => {
  it("flags a seaborn import — no wheel in the Pyodide distribution", () => {
    const r = detectUnsupportedFeatures("import seaborn as sns\n");
    expect(r.imports).toEqual(["seaborn"]);
    expect(r.reasons[0]).toMatch(/seaborn/);
  });

  it("the prelude pins the AGG matplotlib backend for the DOM-less worker", () => {
    expect(buildWasmPrelude()).toContain('MPLBACKEND", "AGG"');
  });

  it("progress() bridges to the JS hook when present and stays harmless without it", () => {
    const p = buildWasmPrelude();
    expect(p).toContain("__hermeticProgress");
    // Node parity executor has no hook: getattr-None guard + blanket except.
    expect(p).toContain('getattr(_js, "__hermeticProgress", None)');
    expect(p).toContain("except Exception:");
  });
});

describe("wildcard parquet paths (run 9ee0e56b — globs cannot match per-file aliases)", () => {
  it("flags the ACTUAL failing shapes: a variable-assigned glob, star-in-filename and double-star", () => {
    const code = [
      'BLDG_GLOB = "release/2026-08-19.0/theme=buildings/type=building/part-*.zstd.parquet"',
      'DIV_GLOB  = "release/2026-08-19.0/theme=divisions/type=division_area/**"',
      "df = duckdb.sql(f\"SELECT 1 FROM read_parquet('{DIV_GLOB}', hive_partitioning=true)\").df()",
    ].join("\n");
    const r = detectUnsupportedFeatures(code);
    expect(r.reasons.some((x) => /wildcard parquet path/.test(x))).toBe(true);
  });

  it("does NOT flag alias-list reads, exact paths, or markdown bold in docstrings", () => {
    const code = [
      '"""Analysis of **isolated** buildings — uses declared checks."""',
      "df = duckdb.sql(\"SELECT 1 FROM read_parquet(['release/theme=buildings/part-00000.zstd.parquet', 'release/theme=buildings/part-00001.zstd.parquet'], hive_partitioning=true)\").df()",
      "pdf = pd.read_parquet('/data/input.parquet')",
    ].join("\n");
    expect(detectUnsupportedFeatures(code)).toEqual({ imports: [], reasons: [] });
  });
});
