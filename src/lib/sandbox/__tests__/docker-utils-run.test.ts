import { describe, it, expect } from "vitest";
import { run } from "@/lib/sandbox/docker-utils";

// These exercise the stdin handling of run() with plain shell commands (no
// Docker needed). The regression: an EMPTY-string input was treated as "no
// input", so stdin was never closed and a stdin-reading command (e.g. the
// `cat > /data/input.csv` a remote source issues) hung until the timeout.
describe("run() stdin handling", () => {
  it("closes stdin for empty-string input so a stdin reader exits immediately", async () => {
    const res = await run("cat", [], { input: "", timeoutMs: 3000 });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
  });

  it("writes and closes stdin for non-empty input", async () => {
    const res = await run("cat", [], { input: "hello", timeoutMs: 3000 });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("hello");
  });

  it("runs a command that does not read stdin", async () => {
    const res = await run("echo", ["hi"], { timeoutMs: 3000 });
    expect(res.stdout.trim()).toBe("hi");
  });
});

// The abort listener on a RUN-LIFETIME signal must not accumulate — run() is
// called many times per run (create, cp, exec, rm...), and `{once:true}`
// only cleans up if the signal actually fires (L3 backlog #9).
describe("run() abort-listener hygiene", () => {
  it("removes its abort listener from the caller's signal when the command completes", async () => {
    const ac = new AbortController();
    const added: EventListenerOrEventListenerObject[] = [];
    const removed: EventListenerOrEventListenerObject[] = [];
    const origAdd = ac.signal.addEventListener.bind(ac.signal);
    const origRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((
      type: string,
      cb: EventListenerOrEventListenerObject,
      o?: unknown
    ) => {
      if (type === "abort") added.push(cb);
      return origAdd(type as "abort", cb as never, o as never);
    }) as typeof ac.signal.addEventListener;
    ac.signal.removeEventListener = ((type: string, cb: EventListenerOrEventListenerObject) => {
      if (type === "abort") removed.push(cb);
      return origRemove(type as "abort", cb as never);
    }) as typeof ac.signal.removeEventListener;

    await run("echo", ["hi"], { timeoutMs: 3000, signal: ac.signal });
    await run("echo", ["hi"], { timeoutMs: 3000, signal: ac.signal });

    expect(added).toHaveLength(2);
    expect(removed).toHaveLength(2);
    // The exact listeners that were added were removed.
    expect(removed[0]).toBe(added[0]);
    expect(removed[1]).toBe(added[1]);
  });

  it("still aborts the child when the caller's signal fires", async () => {
    const ac = new AbortController();
    const p = run("sleep", ["30"], { signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toThrow(/aborted/i);
  });
});
