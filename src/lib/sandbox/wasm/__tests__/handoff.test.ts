/**
 * The sidecar-side stream WASM executor: emits an execute-request, awaits the
 * browser's POSTed envelope (via the registry), relays + decodes it to an
 * ExecutionResult. Covers success, timeout, and a rejected (invalid) envelope.
 */
import { describe, it, expect, vi } from "vitest";
import { createStreamWasmExecutor, type WasmExecuteRequest } from "@/lib/sandbox/wasm/handoff";
import { createHandoffRegistry } from "@/lib/sandbox/wasm/handoff-registry";

function seq() {
  let n = 0;
  return () => `run-${n++}`;
}

describe("createStreamWasmExecutor", () => {
  it("emits a request, and the browser's envelope becomes a success ExecutionResult", async () => {
    const registry = createHandoffRegistry(seq());
    const emit = vi.fn<(r: WasmExecuteRequest) => void>();
    const exec = createStreamWasmExecutor({ registry, emit });

    const p = exec("region,revenue\nn,1\n", "print(1)", {
      additionalFiles: [{ path: "/data/x", content: "y" }],
    });

    // The request was emitted with the code + files (browser will run it).
    expect(emit).toHaveBeenCalledTimes(1);
    const req = emit.mock.calls[0][0];
    expect(req.type).toBe("wasm-execute");
    expect(req.code).toBe("print(1)");
    expect(req.files).toEqual([{ path: "/data/x", content: "y" }]);

    // The browser POSTs its result → registry.resolve → the executor completes.
    registry.resolve(req.id, {
      exitCode: 0,
      output: { results: { n: 1 }, chart_data: {}, images: {} },
    });

    const result = await p;
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (result.success) expect(result.results).toMatchObject({ n: 1 });
  });

  it("times out into an errorKind:'timeout' result when the browser never answers", async () => {
    const registry = createHandoffRegistry(seq());
    const exec = createStreamWasmExecutor({ registry, emit: () => {}, timeoutMs: 20 });
    const result = await exec("a,b\n1,2\n", "print(1)", {});
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorKind).toBe("timeout");
    expect(registry.size()).toBe(0); // the pending handoff was cleaned up
  });

  it("rejects an invalid worker envelope (relay gate) as errorKind:'infra'", async () => {
    const registry = createHandoffRegistry(seq());
    const emit = vi.fn<(r: WasmExecuteRequest) => void>();
    const exec = createStreamWasmExecutor({ registry, emit });
    const p = exec("a,b\n1,2\n", "print(1)", {});
    const id = emit.mock.calls[0][0].id;
    // A non-integer exitCode is rejected by validateWorkerResult.
    registry.resolve(id, { exitCode: 1.5 as unknown as number, output: {} });
    const result = await p;
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorKind).toBe("infra");
  });
});
