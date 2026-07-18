/**
 * The run recorder writes a forensic trail to data/runs/<runId>/ incrementally,
 * so a failed/crashed run is still debuggable. These exercise the real fs path
 * inside a run scope (runId learned at runtime) and clean up after themselves.
 */
import { describe, it, expect } from "vitest";
import { rm, readFile, readdir, stat } from "fs/promises";
import { join } from "path";
import { runWithRunId, getRunId } from "@/lib/run-context";
import {
  recordRunStart,
  recordAttemptCode,
  recordAttemptOutcome,
  recordRunArtifact,
} from "../run-recorder";

/** Poll for a file to appear (writes are fire-and-forget). */
async function waitFor(path: string, tries = 50): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      await stat(path);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
  return false;
}

describe("run-recorder", () => {
  it("persists attempt code, error, journal, and final code under data/runs/<runId>", async () => {
    await runWithRunId(async () => {
      const id = getRunId()!;
      const dir = join(process.cwd(), "data", "runs", id);
      try {
        recordRunStart({ question: "which building is most isolated" });
        recordAttemptCode(1, "print('attempt one')");
        recordAttemptOutcome(1, {
          success: false,
          error: "Out of memory — killed (OOM)",
          errorKind: "oom",
          executionMs: 1600000,
        });
        recordAttemptCode(2, "print('attempt two')");
        recordAttemptOutcome(2, { success: true, executionMs: 42, hasResults: true });
        recordRunArtifact("code.py", "print('attempt two')");

        expect(await waitFor(join(dir, "attempt-02.py"))).toBe(true);
        const files = await readdir(dir);
        expect(files).toEqual(
          expect.arrayContaining([
            "meta.json",
            "attempt-01.py",
            "attempt-01.error.txt",
            "attempt-02.py",
            "code.py",
            "journal.jsonl",
          ])
        );

        // The OOMing attempt's exact code survives — the whole point.
        expect(await readFile(join(dir, "attempt-01.py"), "utf-8")).toBe("print('attempt one')");
        expect(await readFile(join(dir, "attempt-01.error.txt"), "utf-8")).toContain("OOM");

        // Journal has an ordered event stream.
        const journal = (await readFile(join(dir, "journal.jsonl"), "utf-8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        expect(journal.some((e) => e.type === "codegen" && e.attempt === 1)).toBe(true);
        expect(
          journal.some((e) => e.type === "exec" && e.attempt === 1 && e.errorKind === "oom")
        ).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it("is a no-op (no throw) outside a run scope", () => {
    // getRunId() is undefined here → every call returns immediately.
    expect(() => {
      recordRunStart({ question: "q" });
      recordAttemptCode(1, "x");
      recordAttemptOutcome(1, { success: true });
      recordRunArtifact("code.py", "x");
    }).not.toThrow();
  });
});
