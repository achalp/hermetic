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
