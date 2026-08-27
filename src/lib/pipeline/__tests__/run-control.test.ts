/**
 * Run-control registry: the per-run abort signal + container registration that
 * powers stop-on-demand, and the "is this container alive" guard the sweeper
 * uses. docker rm is stubbed (child_process); AsyncLocalStorage runId is driven
 * via run-context.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { rmCalls, psOutput, inspectCreated } = vi.hoisted(() => ({
  rmCalls: [] as string[][],
  psOutput: { value: "" },
  // docker inspect {{.Created}} per container name; "" = inspect fails/empty.
  inspectCreated: { byName: {} as Record<string, string> },
}));
vi.mock("node:child_process", () => ({
  execFile: (_cmd: string, args: string[], cb?: (e: unknown, stdout?: string) => void) => {
    const done = (out: string) => {
      if (typeof cb === "function") cb(null, out);
      return {};
    };
    if (args[0] === "ps") {
      // Real docker filters `ps` by the name prefix. Only the sandbox sweep
      // sees psOutput; the egress-gateway sweep (name=hermetic-egress-gw-)
      // matches no sandbox containers, so it must return empty.
      const nameFilter = (args.find((a) => a.startsWith("name=")) ?? "").slice("name=".length);
      return done(nameFilter.startsWith("hermetic-egress") ? "" : psOutput.value);
    }
    if (args[0] === "inspect") {
      const name = args[args.length - 1];
      return done(inspectCreated.byName[name] ?? "");
    }
    if (args[0] === "network") {
      // `network ls` reports no orphan egress networks in these tests.
      if (args[1] === "ls") return done("");
      rmCalls.push(args);
      return done("");
    }
    rmCalls.push(args);
    return done("");
  },
}));
vi.mock("@/lib/logger", () => ({
  errMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  setRunIdProvider: vi.fn(),
}));

import { runWithRunId } from "@/lib/run-context";
import {
  registerRun,
  getRunSignal,
  registerContainer,
  unregisterContainer,
  reportProgress,
  stopRun,
  isSandboxContainerActive,
  isRunStopped,
  reapOrphanSandboxContainers,
  endRun,
  setRunFailureHints,
  getRunFailureHints,
  ambientWasmExecutor,
} from "@/lib/pipeline/run-control";
import { getHandoffRegistry } from "@/lib/sandbox/wasm/handoff-singleton";

// runWithRunId mints a random id; capture it so the test can drive stopRun().
async function inRun<T>(fn: (runId: string) => Promise<T>): Promise<T> {
  return runWithRunId(async () => {
    const { getRunId } = await import("@/lib/run-context");
    return fn(getRunId()!);
  });
}

beforeEach(() => {
  rmCalls.length = 0;
});

describe("run-control", () => {
  it("registers a run and exposes its abort signal inside the run scope", async () => {
    await inRun(async (runId) => {
      const controller = registerRun(runId);
      const sig = getRunSignal();
      expect(sig).toBe(controller.signal);
      expect(sig!.aborted).toBe(false);
      endRun(runId);
    });
  });

  it("stopRun aborts the signal, flags stopped, and docker-rm's every registered container", async () => {
    await inRun(async (runId) => {
      registerRun(runId);
      registerContainer("c1");
      registerContainer("c2");
      expect(isSandboxContainerActive("c1")).toBe(true);

      const ok = await stopRun(runId);
      expect(ok).toBe(true);
      expect(getRunSignal()!.aborted).toBe(true);
      expect(isRunStopped()).toBe(true);
      // Both containers force-removed.
      const removed = rmCalls.map((a) => a.join(" "));
      expect(removed).toContain("rm -f c1");
      expect(removed).toContain("rm -f c2");
      endRun(runId);
    });
  });

  it("stopRun on an unknown run returns false (already finished)", async () => {
    expect(await stopRun("does-not-exist")).toBe(false);
  });

  it("unregisterContainer removes the sweeper's active mark", async () => {
    await inRun(async (runId) => {
      registerRun(runId);
      registerContainer("c9");
      expect(isSandboxContainerActive("c9")).toBe(true);
      unregisterContainer("c9");
      expect(isSandboxContainerActive("c9")).toBe(false);
      endRun(runId);
    });
  });

  it("reportProgress forwards to the run's onProgress sink", async () => {
    const onProgress = vi.fn();
    await inRun(async (runId) => {
      registerRun(runId, onProgress);
      reportProgress({ phase: "scanning", detail: "buildings", elapsedMs: 1000 });
      endRun(runId);
    });
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "scanning", detail: "buildings" })
    );
  });

  it("endRun clears the container ownership (so the sweeper would reap a straggler)", async () => {
    await inRun(async (runId) => {
      registerRun(runId);
      registerContainer("c-end");
      endRun(runId);
      expect(isSandboxContainerActive("c-end")).toBe(false);
    });
  });

  it("reapOrphanSandboxContainers removes running containers NOT registered to a live run", async () => {
    // docker ps reports two sandbox containers; only one belongs to a live run.
    psOutput.value = "hermetic-sandbox-live\nhermetic-sandbox-orphan\n";
    await inRun(async (runId) => {
      registerRun(runId);
      registerContainer("hermetic-sandbox-live");

      const reaped = await reapOrphanSandboxContainers();
      expect(reaped).toBe(1);
      const removed = rmCalls.map((a) => a.join(" "));
      expect(removed).toContain("rm -f hermetic-sandbox-orphan");
      expect(removed).not.toContain("rm -f hermetic-sandbox-live"); // live run untouched
      endRun(runId);
    });
    psOutput.value = "";
  });

  it("reaper SPARES an unregistered container younger than the orphan age floor", async () => {
    // Regression guard for the split-brain class: if registration ever breaks
    // again, a fresh live container must survive the first sweep tick and be
    // called out by name, not silently killed.
    psOutput.value = "hermetic-sandbox-young\nhermetic-sandbox-old\n";
    inspectCreated.byName["hermetic-sandbox-young"] = new Date().toISOString();
    inspectCreated.byName["hermetic-sandbox-old"] = new Date(
      Date.now() - 2 * 60 * 60 * 1000
    ).toISOString();
    const reaped = await reapOrphanSandboxContainers();
    expect(reaped).toBe(1);
    const removed = rmCalls.map((a) => a.join(" "));
    expect(removed).toContain("rm -f hermetic-sandbox-old");
    expect(removed).not.toContain("rm -f hermetic-sandbox-young");
    psOutput.value = "";
    inspectCreated.byName = {};
  });

  it("skill failure hints attach to the current run and die with it", async () => {
    const hints = [{ pattern: "pivot", hint: "aggregate in DuckDB", skill: "cohort" }];
    await inRun(async (runId) => {
      registerRun(runId);
      expect(getRunFailureHints()).toEqual([]); // none registered yet
      setRunFailureHints(hints);
      expect(getRunFailureHints()).toEqual(hints);
      endRun(runId);
      expect(getRunFailureHints()).toEqual([]); // torn down with the run
    });
  });

  it("skill failure hint accessors are safe no-ops outside a run context", () => {
    setRunFailureHints([{ pattern: "x", hint: "y", skill: "z" }]);
    expect(getRunFailureHints()).toEqual([]);
  });
});

describe("ambientWasmExecutor (live webview handoff)", () => {
  it("dispatches to the run's webview and completes when the browser posts back", async () => {
    await inRun(async (runId) => {
      const reg = getHandoffRegistry();
      // The registered dispatcher stands in for the patch stream + browser: it
      // resolves the pending handoff as /api/wasm-result would on a POST.
      registerRun(runId, undefined, (req) => {
        expect(req.type).toBe("wasm-execute");
        expect(req.code).toBe("print(1)");
        reg.resolve(req.id, {
          exitCode: 0,
          output: { results: { ok: 1 }, chart_data: {}, images: {} },
        });
      });
      const result = await ambientWasmExecutor()("a,b\n1,2\n", "print(1)", {});
      expect(result.success, JSON.stringify(result)).toBe(true);
    });
  });

  it("fails cleanly (no hang) when the run registered no webview stream", async () => {
    await inRun(async (runId) => {
      registerRun(runId); // no onWasmExecute dispatcher
      const result = await ambientWasmExecutor()("a,b\n1,2\n", "print(1)", {});
      expect(result.success).toBe(false);
      // the failed dispatch left no pending handoff behind
      expect(getHandoffRegistry().size()).toBe(0);
    });
  });
});
