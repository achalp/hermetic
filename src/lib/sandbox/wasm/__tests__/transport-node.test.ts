/**
 * Phase 1c-transport integration test (spec §4a / §7 T3). Drives the REAL
 * `NodeWasmTransport` over actual `node:worker_threads` — no mocks — to pin the
 * three transport guarantees end to end:
 *   (a) a valid worker envelope round-trips to a SUCCESS ExecutionResult, with the
 *       pushed `{ code, files }` bytes visible to the worker body;
 *   (b) a worker that posts a NON-envelope is dropped by the relay and the run
 *       fails cleanly — the raw worker payload is NEVER forwarded;
 *   (c) a worker that HANGS (busy real thread) is killed by the supervisor
 *       wall-clock timer and the run returns errorKind "timeout".
 *
 * The worker bodies are pure, self-contained functions (their source is shipped
 * into the worker), which is exactly how a later phase swaps in a Pyodide body.
 */
import { describe, it, expect } from "vitest";
import { NodeWasmTransport } from "@/lib/sandbox/wasm/transport-node";

describe("NodeWasmTransport — worker_threads transport + relay + supervisor timeout", () => {
  it("(a) round-trips a valid envelope to a success ExecutionResult, with pushed bytes", async () => {
    const transport = new NodeWasmTransport({
      timeoutMs: 5_000,
      // Body reads the PUSHED run (code + files as bytes) and emits an envelope —
      // proving data is pushed, not resolved via a dataRef.
      workerFn: (run) => ({
        kind: "result",
        exitCode: 0,
        output: {
          results: {
            code_len: run.code.length,
            file_count: run.files.length,
            first_file: run.files[0]?.content ?? null,
          },
        },
      }),
    });

    try {
      const result = await transport.run({
        code: "print(1)", // length 8
        files: [{ path: "/data/input.csv", content: "region,revenue\nnorth,100\n" }],
      });

      expect(result.success, JSON.stringify(result)).toBe(true);
      if (!result.success) return;
      expect(result.results).toMatchObject({
        code_len: 8,
        file_count: 1,
        first_file: "region,revenue\nnorth,100\n",
      });
    } finally {
      await transport.dispose();
    }
  }, 15_000);

  it("(a2) the default (stub) worker body also round-trips", async () => {
    const transport = new NodeWasmTransport({ timeoutMs: 5_000 });
    try {
      const result = await transport.run({ code: "noop", files: [] });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.results).toMatchObject({ runtime: "wasm-stub", file_count: 0 });
      }
    } finally {
      await transport.dispose();
    }
  }, 15_000);

  it("(b) drops a non-envelope worker message and never forwards the raw payload", async () => {
    const transport = new NodeWasmTransport({
      timeoutMs: 5_000,
      // A worker trying to smuggle a non-envelope shape past the relay.
      workerFn: () => ({ kind: "exfil", secret: "leaked-bytes" }),
    });

    try {
      const result = await transport.run({ code: "whatever", files: [] });

      expect(result.success).toBe(false);
      if (result.success) return;
      // Failed cleanly through the relay path...
      expect(result.error).toMatch(/relay/i);
      expect(result.errorKind).toBe("infra");
      // ...and the raw worker payload was NOT forwarded onward.
      expect(result.error).not.toContain("leaked-bytes");
    } finally {
      await transport.dispose();
    }
  }, 15_000);

  it("(b2) drops a bare non-object worker message too", async () => {
    const transport = new NodeWasmTransport({
      timeoutMs: 5_000,
      workerFn: () => "not-an-object",
    });
    try {
      const result = await transport.run({ code: "x", files: [] });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.errorKind).toBe("infra");
    } finally {
      await transport.dispose();
    }
  }, 15_000);

  it("(c) supervisor timer terminates a hung worker and returns errorKind 'timeout'", async () => {
    const transport = new NodeWasmTransport({
      timeoutMs: 300, // tight wall-clock cap
      // A busy REAL thread: it can never post back nor starve the main-thread timer.
      workerFn: () => {
        while (true) {
          /* spin */
        }
      },
    });

    try {
      const start = Date.now();
      const result = await transport.run({ code: "hang", files: [] });
      const elapsed = Date.now() - start;

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.errorKind).toBe("timeout");
      // The supervisor fired near its cap, not after some worker-side completion.
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      await transport.dispose();
    }
  }, 15_000);
});
