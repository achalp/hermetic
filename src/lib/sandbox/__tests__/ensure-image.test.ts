/**
 * The sandbox image must EXIST before the first container starts.
 *
 * The web path builds it (`start.sh`). The desktop app ships a sidecar, not a
 * repo — no Dockerfile, no toolchain — so making Docker a real option there
 * (it had none: the app pinned wasm, the least-proven tier) requires fetching
 * the attested release image from GHCR instead.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = vi.hoisted(() => ({ argv: [] as string[][], results: new Map<string, number>() }));

vi.mock("@/lib/sandbox/docker-utils", () => ({
  run: vi.fn(async (_bin: string, args: string[]) => {
    calls.argv.push(args);
    const key = args[0] === "image" ? "image inspect" : args[0]!;
    const exitCode = calls.results.get(key) ?? 0;
    return { stdout: "", stderr: exitCode ? "boom" : "", exitCode };
  }),
}));

import { ensureSandboxImage, resetSandboxImageCacheForTests } from "@/lib/sandbox/ensure-image";

const argvFor = (head: string) =>
  calls.argv.filter((a) => (a[0] === "image" ? "image inspect" : a[0]) === head);

beforeEach(() => {
  calls.argv = [];
  calls.results.clear();
  resetSandboxImageCacheForTests();
});

describe("ensureSandboxImage", () => {
  it("does nothing when the image is already local — the common path", async () => {
    await ensureSandboxImage("0.5.11");
    expect(argvFor("image inspect")).toHaveLength(1);
    expect(argvFor("pull")).toHaveLength(0);
  });

  it("pulls the app's OWN version, never `latest`", async () => {
    calls.results.set("image inspect", 1);
    await ensureSandboxImage("0.5.11");
    const pull = argvFor("pull")[0]!;
    // The image and the code driving it are one artifact: a `latest` that moved
    // under a pinned app is how a sandbox breaks on a machine nobody touched.
    expect(pull[1]).toBe("ghcr.io/achalp/hermetic-sandbox:0.5.11");
    expect(pull[1]).not.toContain("latest");
  });

  it("tags the pulled image to the local name every call site uses", async () => {
    calls.results.set("image inspect", 1);
    await ensureSandboxImage("0.5.11");
    expect(argvFor("tag")[0]).toEqual([
      "tag",
      "ghcr.io/achalp/hermetic-sandbox:0.5.11",
      "hermetic-sandbox",
    ]);
  });

  it("reports pull progress so a first-run download is visible, not a stall", async () => {
    calls.results.set("image inspect", 1);
    const phases: string[] = [];
    await ensureSandboxImage("0.5.11", (e) => phases.push(e.phase));
    expect(phases).toEqual(["checking", "pulling", "ready"]);
  });

  it("fails with an actionable message naming the escape hatch", async () => {
    calls.results.set("image inspect", 1);
    calls.results.set("pull", 1);
    await expect(ensureSandboxImage("0.5.11")).rejects.toThrow(/built-in engine in Settings/);
  });

  it("memoizes SUCCESS only — a failed pull must not become a permanent refusal", async () => {
    calls.results.set("image inspect", 1);
    calls.results.set("pull", 1);
    await expect(ensureSandboxImage("0.5.11")).rejects.toThrow();
    // Offline once is not offline forever: the next run retries rather than
    // inheriting a cached "no" (same rule the daemon-memory probe follows).
    calls.results.set("pull", 0);
    await expect(ensureSandboxImage("0.5.11")).resolves.toBeUndefined();
    expect(argvFor("pull")).toHaveLength(2);

    // ...and once it succeeds, it is not re-checked on every run.
    calls.argv = [];
    await ensureSandboxImage("0.5.11");
    expect(calls.argv).toHaveLength(0);
  });

  it("does not bound the pull with a timeout", async () => {
    // Hundreds of MB over the user's connection — the same reason a value profile
    // has no wall clock. A stuck pull is the user's to cancel, not a timer's to guess.
    calls.results.set("image inspect", 1);
    const { run } = await import("@/lib/sandbox/docker-utils");
    await ensureSandboxImage("0.5.11");
    const pullCall = (run as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[1] as string[])[0] === "pull"
    )!;
    expect(pullCall[2]).toBeUndefined();
  });
});
