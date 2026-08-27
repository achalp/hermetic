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
});
