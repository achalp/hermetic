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

describe("cancel — terminate an in-flight run (stop-on-demand parity)", () => {
  it("aborts the injected run's signal and posts NO envelope for a cancelled id", async () => {
    let seenSignal: AbortSignal | undefined;
    const run = vi.fn(
      (_r: unknown, signal?: AbortSignal) =>
        new Promise((_res, rej) => {
          seenSignal = signal;
          signal?.addEventListener("abort", () => rej(new Error("cancelled")));
        })
    );
    const post = vi.fn().mockResolvedValue(undefined);
    const h = createClientHandoff({ run: run as never, post });

    h.handle(req("c1"));
    await flush();
    expect(seenSignal?.aborted).toBe(false);

    h.cancel("c1");
    await flush();
    expect(seenSignal?.aborted).toBe(true);
    // The sidecar settled on its own abort path — a posted envelope would 404.
    expect(post).not.toHaveBeenCalled();
  });

  it("is idempotent and a no-op for unknown, falsy, or already-finished ids", async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, output: "" });
    const post = vi.fn().mockResolvedValue(undefined);
    const h = createClientHandoff({ run, post });

    h.cancel(undefined); // a malformed __wasm_cancel patch must be inert
    h.cancel(null);
    h.cancel("never-started");
    h.handle(req("done1"));
    await flush();
    expect(post).toHaveBeenCalledTimes(1);
    h.cancel("done1"); // finished — nothing in flight
    h.cancel("done1");
    await flush();
    expect(post).toHaveBeenCalledTimes(1); // no extra effects
  });

  it("a run failure that was NOT a cancel still answers the sidecar", async () => {
    const run = vi.fn().mockRejectedValue(new Error("worker died"));
    const post = vi.fn().mockResolvedValue(undefined);
    const h = createClientHandoff({ run, post });
    h.handle(req("f1"));
    await flush();
    expect(post).toHaveBeenCalledWith(
      "f1",
      expect.objectContaining({ exitCode: 1, stderr: expect.stringContaining("worker died") })
    );
  });
});
