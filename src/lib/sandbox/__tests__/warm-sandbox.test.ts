import { describe, it, expect } from "vitest";
import { WarmSandboxManager, type WarmSandboxBackend } from "@/lib/sandbox/warm-sandbox";
import type { ExecutionResult } from "@/lib/contracts/execution";

/**
 * The warm Docker backend shares ONE container + /data paths. Investigate runs
 * sub-questions in parallel, so the manager MUST serialize backend operations —
 * otherwise concurrent loads/executes corrupt each other's script/data (the
 * observed `NameError: write_output is not defined` + EPIPE + blank charts).
 */
class TrackingBackend implements WarmSandboxBackend {
  active = 0;
  maxActive = 0;
  loads: string[] = [];

  async warmup(): Promise<void> {}
  async isHealthy(): Promise<boolean> {
    return true;
  }
  async destroy(): Promise<void> {}

  private async critical(): Promise<void> {
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((r) => setTimeout(r, 5));
    this.active--;
  }

  async loadData(csvId: string): Promise<void> {
    this.loads.push(csvId);
    await this.critical();
  }
  writeFilesCalls = 0;
  async writeFiles(): Promise<void> {
    this.writeFilesCalls++;
  }
  lastHooks: unknown = "unset";
  async executeScript(_code: string, hooks?: unknown): Promise<ExecutionResult> {
    this.lastHooks = hooks;
    await this.critical();
    return { success: true, results: {}, chart_data: {}, images: {}, execution_ms: 1 };
  }
  async executeFull(): Promise<ExecutionResult> {
    return { success: true, results: {}, chart_data: {}, images: {}, execution_ms: 1 };
  }
}

describe("WarmSandboxManager concurrency", () => {
  it("serializes parallel executions on the shared container (never overlaps)", async () => {
    const backend = new TrackingBackend();
    const mgr = new WarmSandboxManager(backend);

    // Fire 5 distinct sub-questions concurrently, as an Investigate wave does.
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => mgr.execute(`csv-${i}`, `content-${i}`, `code-${i}`))
    );

    expect(results.every((r) => r.success)).toBe(true);
    expect(backend.maxActive).toBe(1); // the lock held — no interleaving
    expect(backend.loads).toHaveLength(5); // each distinct csvId reloaded its data
  });

  it("reuses loaded data when the same csvId runs again (no redundant reload)", async () => {
    const backend = new TrackingBackend();
    const mgr = new WarmSandboxManager(backend);

    await mgr.execute("csv-a", "content-a", "code-1");
    await mgr.execute("csv-a", "content-a", "code-2"); // same data → skip reload

    expect(backend.loads).toEqual(["csv-a"]); // loaded once
    expect(backend.maxActive).toBe(1);
  });
});

describe("hooks forwarding (finding M5)", () => {
  it("threads execute()'s hooks through to the backend executeScript", async () => {
    const backend = new TrackingBackend();
    const mgr = new WarmSandboxManager(backend);
    const hooks = { signal: new AbortController().signal, onContainerStart: () => {} };
    await mgr.execute("csv-1", "a,b\n1,2", "code", { hooks });
    // execute() accepted hooks but never passed them on — a user Stop could not
    // reach the shared warm container.
    expect(backend.lastHooks).toBe(hooks);
  });
});

describe("auxiliary files on the data-reused path (run-7 fix)", () => {
  it("writes additionalFiles on EVERY execute, including data reuse", async () => {
    const backend = new TrackingBackend();
    const mgr = new WarmSandboxManager(backend);
    await mgr.execute("csv-1", "a,b\n1,2", "code", { additionalFiles: [] });
    const afterFirst = backend.writeFilesCalls;
    // Same csvId → data reused → loadData skipped — but files must still land.
    await mgr.execute("csv-1", "a,b\n1,2", "code", { additionalFiles: [] });
    expect(backend.writeFilesCalls).toBeGreaterThan(afterFirst);
  });
});
