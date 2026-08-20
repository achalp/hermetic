/**
 * streamExec() runs `docker exec` via child_process.spawn and STREAMS stdout,
 * parsing the prelude's JSONL progress heartbeats ({"__progress": {...}}) live
 * so the last phase / duckdb config survive a hard container kill. These tests
 * mock node:child_process entirely — no docker daemon is touched. The fake
 * child is an EventEmitter with EventEmitter stdout/stderr we drive by hand.
 */
import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SandboxProgress } from "@/lib/contracts/execution";

/** A stand-in for a ChildProcess: an emitter with emitter stdout/stderr. */
class FakeChild extends EventEmitter {
  stdout = Object.assign(new EventEmitter(), { resume: vi.fn() });
  stderr = Object.assign(new EventEmitter(), { resume: vi.fn() });
  kill = vi.fn();
}

// Every spawn() call records its args and returns a fresh fake child. The first
// spawn is the `docker exec`; the abort path fires a second `docker rm -f`.
const spawnCalls: Array<{ args: unknown[]; child: FakeChild }> = [];
const spawnMock = vi.fn((..._args: unknown[]) => {
  const child = new FakeChild();
  spawnCalls.push({ args: _args, child });
  return child;
});
vi.mock("node:child_process", () => ({
  spawn: (...a: unknown[]) => spawnMock(...a),
}));

import { streamExec } from "@/lib/sandbox/stream-exec";

/** The fake child created by the FIRST spawn (the `docker exec`). */
const execChild = () => spawnCalls[0].child;
const emitOut = (s: string) => execChild().stdout.emit("data", Buffer.from(s));

beforeEach(() => {
  vi.clearAllMocks();
  spawnCalls.length = 0;
});

describe("streamExec — live stdout progress streaming", () => {
  it("resolves exitCode 0 and captures the last progress phase", async () => {
    const seen: SandboxProgress[] = [];
    const p = streamExec("cid-1", { onProgress: (x) => seen.push(x) });

    // spawn ran synchronously inside the Promise executor.
    expect(spawnCalls[0].args[0]).toBe("docker");
    expect(spawnCalls[0].args[1]).toEqual([
      "exec",
      "cid-1",
      "sh",
      "-c",
      "python3 -u /data/script.py 2>/data/stderr.txt",
    ]);

    emitOut('{"__progress":{"phase":"loading"}}\n');
    emitOut('{"__progress":{"phase":"analyzing"}}\n');
    execChild().emit("exit", 0);

    const res = await p;
    expect(res.exitCode).toBe(0);
    expect(res.aborted).toBe(false);
    expect(res.lastPhase).toBe("analyzing");
    expect(seen.map((x) => x.phase)).toEqual(["loading", "analyzing"]);
    // stderr was drained so its pipe never blocks.
    expect(execChild().stderr.resume).toHaveBeenCalled();
  });

  it("captures duckdb_cfg from the progress stream", async () => {
    const p = streamExec("cid-2");
    emitOut('{"__progress":{"phase":"hydrating","duckdb_cfg":"threads=4 memory_limit=2GB"}}\n');
    execChild().emit("exit", 0);
    const res = await p;
    expect(res.duckdbCfg).toBe("threads=4 memory_limit=2GB");
    expect(res.lastPhase).toBe("hydrating");
  });

  it("buffers a progress line split across two stdout chunks", async () => {
    const seen: SandboxProgress[] = [];
    const p = streamExec("cid-3", { onProgress: (x) => seen.push(x) });
    emitOut('{"__progress":{"ph');
    emitOut('ase":"composing"}}\n');
    execChild().emit("exit", 0);
    const res = await p;
    expect(res.lastPhase).toBe("composing");
    expect(seen).toHaveLength(1);
  });

  it("ignores non-JSON and blank stdout lines (real result lives in output.json)", async () => {
    const seen: SandboxProgress[] = [];
    const p = streamExec("cid-4", { onProgress: (x) => seen.push(x) });
    emitOut("not json at all\n");
    emitOut("\n");
    emitOut('{"something":"else"}\n'); // valid JSON but no __progress
    emitOut('{"__progress":{"phase":"done"}}\n');
    execChild().emit("exit", 0);
    const res = await p;
    expect(res.exitCode).toBe(0);
    expect(res.lastPhase).toBe("done");
    expect(seen).toHaveLength(1);
  });

  it("propagates a nonzero exit code", async () => {
    const p = streamExec("cid-5");
    execChild().emit("exit", 137);
    const res = await p;
    expect(res.exitCode).toBe(137);
    expect(res.aborted).toBe(false);
  });

  it("defaults a null exit code to 1", async () => {
    const p = streamExec("cid-6");
    execChild().emit("exit", null);
    const res = await p;
    expect(res.exitCode).toBe(1);
  });
});

describe("streamExec — abort (user Stop)", () => {
  it("fires `docker rm -f` and resolves aborted:true with exitCode -1", async () => {
    const ac = new AbortController();
    const p = streamExec("cid-abort", { signal: ac.signal });

    ac.abort(); // user hits Stop
    // The abort handler tears the container down via a second spawn.
    const rm = spawnCalls.find((c) => (c.args[1] as string[])?.[0] === "rm");
    expect(rm).toBeDefined();
    expect(rm!.args[1]).toEqual(["rm", "-f", "cid-abort"]);

    // Removing the container kills the in-container process → exit fires.
    execChild().emit("exit", 0);
    const res = await p;
    expect(res.aborted).toBe(true);
    expect(res.exitCode).toBe(-1);
  });

  it("aborts immediately when the signal is already aborted at call time", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = streamExec("cid-pre", { signal: ac.signal });
    // rm fired synchronously during construction.
    expect(spawnCalls.some((c) => (c.args[1] as string[])?.[0] === "rm")).toBe(true);
    execChild().emit("exit", 0);
    const res = await p;
    expect(res.aborted).toBe(true);
    expect(res.exitCode).toBe(-1);
  });

  it("retains lastPhase through an abort so the OOM router can localize the peak", async () => {
    const ac = new AbortController();
    const p = streamExec("cid-oom", { signal: ac.signal });
    emitOut('{"__progress":{"phase":"scanning-buildings"}}\n');
    ac.abort();
    execChild().emit("exit", 0);
    const res = await p;
    expect(res.aborted).toBe(true);
    expect(res.lastPhase).toBe("scanning-buildings");
  });
});

describe("streamExec — spawn error", () => {
  it("rejects when the process errors and no abort was requested", async () => {
    const p = streamExec("cid-err");
    execChild().emit("error", new Error("spawn ENOENT"));
    await expect(p).rejects.toThrow("spawn ENOENT");
  });

  it("resolves (not rejects) when an error arrives after an abort", async () => {
    const ac = new AbortController();
    const p = streamExec("cid-err2", { signal: ac.signal });
    ac.abort();
    execChild().emit("error", new Error("killed"));
    const res = await p;
    expect(res.aborted).toBe(true);
    expect(res.exitCode).toBe(-1);
  });
});
