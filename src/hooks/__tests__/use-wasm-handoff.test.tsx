// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useWasmHandoff } from "@/hooks/use-wasm-handoff";
import type { Spec } from "@/lib/contracts/spec";
import type { WasmExecuteRequest } from "@/lib/contracts/stream-state";
import type { HandoffEnvelope } from "@/lib/sandbox/wasm/handoff-registry";

const specWith = (req?: WasmExecuteRequest): Spec =>
  ({ root: "", elements: {}, state: req ? { __wasm_exec: req } : {} }) as unknown as Spec;

const req = (id: string): WasmExecuteRequest => ({
  type: "wasm-execute",
  id,
  csvContent: "a,b\n1,2\n",
  code: "print(1)",
  files: [],
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("useWasmHandoff", () => {
  it("runs and POSTs when a __wasm_exec request appears in the streaming spec", async () => {
    const env: HandoffEnvelope = { exitCode: 0, output: { results: {} } };
    const run = vi.fn<(r: WasmExecuteRequest) => Promise<HandoffEnvelope>>().mockResolvedValue(env);
    const post = vi.fn<(id: string, e: HandoffEnvelope) => Promise<void>>().mockResolvedValue();

    const { rerender } = renderHook(({ spec }) => useWasmHandoff(spec, { run, post }), {
      initialProps: { spec: specWith(undefined) },
    });
    expect(run).not.toHaveBeenCalled(); // no request yet

    await act(async () => {
      rerender({ spec: specWith(req("r1")) });
      await flush();
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("r1", env);
  });

  it("dedupes a request re-delivered across renders (runs once)", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, output: {} });
    const post = vi.fn().mockResolvedValue(undefined);
    const same = req("dup");

    const { rerender } = renderHook(({ spec }) => useWasmHandoff(spec, { run, post }), {
      initialProps: { spec: specWith(same) },
    });
    await act(async () => {
      // a later patch re-renders with the SAME __wasm_exec still present
      rerender({ spec: specWith(same) });
      rerender({ spec: specWith(same) });
      await flush();
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});
