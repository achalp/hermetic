/**
 * executeSandbox routes a `wasm` run to the harness-injected wasmExecutor (never
 * Docker), and fails cleanly when none is configured (headless contexts). Pins the
 * §4a/build-log-D1 dispatch seam.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// hermeticRuntimeFiles reads the runtime dir off disk — stub it so the dispatch
// is tested without touching the filesystem.
vi.mock("@/lib/sandbox/runtime-files", () => ({ hermeticRuntimeFiles: () => [] }));

import { executeSandbox, type WasmExecutor } from "@/lib/sandbox";
import { getInputRegistry } from "@/lib/sandbox/wasm/input-singleton";
import type { ExecutionResult } from "@/lib/contracts/execution";

const success: ExecutionResult = {
  success: true,
  execution_ms: 5,
  results: { ok: true },
  chart_data: {},
  images: {},
};

beforeEach(() => vi.clearAllMocks());

describe("executeSandbox — wasm dispatch", () => {
  it("a local wasm run calls the injected wasmExecutor with the code + files, never Docker", async () => {
    const wasmExecutor = vi.fn<WasmExecutor>(async () => success);
    const result = await executeSandbox("region,revenue\nn,1\n", "print(1)", {
      runtime: "wasm",
      wasmExecutor,
      geojsonContent: null,
    });

    expect(wasmExecutor).toHaveBeenCalledTimes(1);
    const [csv, code, opts] = wasmExecutor.mock.calls[0];
    expect(csv).toContain("region,revenue");
    expect(code).toBe("print(1)");
    expect(opts).toHaveProperty("additionalFiles"); // the runtime package is injected here
    expect(result).toBe(success);
  });

  it("a wasm run with NO executor configured fails cleanly (user-config), never falls through to Docker", async () => {
    const result = await executeSandbox("a,b\n1,2\n", "print(1)", { runtime: "wasm" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorKind).toBe("user-config");
      expect(result.error).toMatch(/WASM sandbox runtime.*no WASM executor|Docker runtime/i);
    }
  });

  it("a wasm run with a bind-mount is rejected by the gate before dispatch (→ Docker)", async () => {
    const wasmExecutor = vi.fn<WasmExecutor>(async () => success);
    const result = await executeSandbox("a,b\n1,2\n", "print(1)", {
      runtime: "wasm",
      wasmExecutor,
      localMountPath: "/tmp/x",
    });
    expect(wasmExecutor).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it("delivers wasmFetchInputs as token URLs to the worker, and releases them after (D13)", async () => {
    let sizeDuringRun = -1;
    const wasmExecutor = vi.fn<WasmExecutor>(async (_csv, _code, opts) => {
      // The host path is NOT exposed — the worker gets an opaque /api/wasm-input token.
      expect(opts.fetchInputs).toHaveLength(1);
      const fi = opts.fetchInputs![0];
      expect(fi.path).toBe("/data/input.csv");
      expect(fi.url).toMatch(/^\/api\/wasm-input\/[0-9a-f-]{36}$/);
      expect(fi.url).not.toContain("/tmp/"); // never the host path
      sizeDuringRun = getInputRegistry().size();
      return success;
    });

    const before = getInputRegistry().size();
    await executeSandbox("", "print(1)", {
      runtime: "wasm",
      wasmExecutor,
      runId: "run-d13",
      wasmFetchInputs: [
        { workerPath: "/data/input.csv", hostPath: "/tmp/materialized-remote.csv" },
      ],
    });

    expect(sizeDuringRun).toBe(before + 1); // token live during the run
    expect(getInputRegistry().size()).toBe(before); // released after (no leak)
  });
});

describe("wasm dispatch — DuckDB is opt-in (build log D18)", () => {
  it("does NOT boot the engine for pandas-only code (a 41MB module nobody asked for)", async () => {
    const wasmExecutor = vi.fn<WasmExecutor>(async (_c, _code, opts) => {
      expect(opts.duckdb).toBeUndefined();
      return success;
    });
    await executeSandbox("a\n1\n", "import pandas as pd\nprint(pd)", {
      runtime: "wasm",
      wasmExecutor,
    });
    expect(wasmExecutor).toHaveBeenCalledOnce();
  });

  it("boots it when the generated code imports duckdb, pointing at the same-origin assets", async () => {
    const wasmExecutor = vi.fn<WasmExecutor>(async (_c, _code, opts) => {
      expect(opts.duckdb?.base).toBe("/duckdb/");
      expect(opts.duckdb?.aliases).toEqual([]);
      return success;
    });
    await executeSandbox("a\n1\n", "import duckdb\nduckdb.sql('SELECT 1')", {
      runtime: "wasm",
      wasmExecutor,
    });
    expect(wasmExecutor).toHaveBeenCalledOnce();
  });

  it("boots it for a remote source and passes the range-token alias, never the upstream URL", async () => {
    const aliases = [{ name: "buildings.parquet", url: "/api/wasm-range/tok-abc" }];
    const wasmExecutor = vi.fn<WasmExecutor>(async (_c, _code, opts) => {
      expect(opts.duckdb?.aliases).toEqual(aliases);
      const serialized = JSON.stringify(opts.duckdb);
      expect(serialized).not.toContain("s3://");
      expect(serialized).not.toContain("amazonaws.com");
      return success;
    });
    // Note: the code does NOT import duckdb — the alias alone forces the boot.
    await executeSandbox("a\n1\n", "print(1)", {
      runtime: "wasm",
      wasmExecutor,
      wasmDuckDbAliases: aliases,
    });
    expect(wasmExecutor).toHaveBeenCalledOnce();
  });
});
