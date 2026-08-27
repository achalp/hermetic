import { describe, it, expect, vi } from "vitest";
import { createClientHandoff } from "@/lib/sandbox/wasm/client-handoff";
import type { WasmExecuteRequest } from "@/lib/contracts/stream-state";
import type { HandoffEnvelope } from "@/lib/sandbox/wasm/handoff-registry";

const req = (id: string): WasmExecuteRequest => ({
  type: "wasm-execute",
  id,
  csvContent: "a,b\n1,2\n",
  code: "print(1)",
  files: [],
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createClientHandoff", () => {
  it("runs the request and POSTs the worker envelope back", async () => {
    const env: HandoffEnvelope = { exitCode: 0, output: { results: { n: 1 } } };
    const run = vi.fn().mockResolvedValue(env);
    const post = vi.fn().mockResolvedValue(undefined);
    const h = createClientHandoff({ run, post });

    h.handle(req("a"));
    await flush();

    expect(run).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith("a", env);
    expect(h.size()).toBe(1);
  });

  it("is idempotent per id — a re-delivered request runs exactly once", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, output: {} });
    const post = vi.fn().mockResolvedValue(undefined);
    const h = createClientHandoff({ run, post });

    h.handle(req("dup"));
    h.handle(req("dup"));
    h.handle(req("dup"));
    await flush();

    expect(run).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("ignores a malformed or empty request", async () => {
    const run = vi.fn();
    const post = vi.fn();
    const h = createClientHandoff({ run, post });

    h.handle(null);
    h.handle(undefined);
    h.handle({ type: "nope", id: "x" } as unknown as WasmExecuteRequest);
    h.handle({ type: "wasm-execute", id: "" } as unknown as WasmExecuteRequest);
    await flush();

    expect(run).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(h.size()).toBe(0);
  });

  it("on a worker failure, POSTs a non-zero envelope so the sidecar resolves", async () => {
    const run = vi.fn().mockRejectedValue(new Error("pyodide boom"));
    const post = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const h = createClientHandoff({ run, post, onError });

    h.handle(req("fail"));
    await flush();

    expect(onError).toHaveBeenCalledWith("fail", expect.any(Error));
    const [id, env] = post.mock.calls[0];
    expect(id).toBe("fail");
    expect(env.exitCode).toBe(1);
    expect(env.stderr).toContain("pyodide boom");
  });

  it("surfaces a POST failure to onError (nothing left to do)", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, output: {} });
    const post = vi.fn().mockRejectedValue(new Error("network down"));
    const onError = vi.fn();
    const h = createClientHandoff({ run, post, onError });

    h.handle(req("postfail"));
    await flush();

    expect(onError).toHaveBeenCalledWith("postfail", expect.any(Error));
  });

  it("tolerates no onError sink on failure paths", async () => {
    const run = vi.fn().mockRejectedValue("stringy");
    const post = vi.fn().mockRejectedValue("also stringy");
    const h = createClientHandoff({ run, post });

    h.handle(req("noerr"));
    await flush();
    // reached here without throwing; the fallback envelope stringified the error
    expect(post).toHaveBeenCalledWith("noerr", expect.objectContaining({ stderr: "stringy" }));
  });
});
