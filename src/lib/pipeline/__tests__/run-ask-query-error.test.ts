/**
 * Error-channel contract for the Ask pipeline: a failing run must emit the
 * REAL message on `/state/__error` (contracts/stream-state) — previously only
 * the UI Annotation carried it, so the CLI matched serialized-JSON substrings
 * and MCP fell back to the literal "pipeline error". Driven through the real
 * runPatchStream so the returned runId and the accumulated lines are the same
 * ones the harnesses consume.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setPathRoots } from "@/lib/paths";
import { runPatchStream } from "@/lib/pipeline/patch-stream";
import { runAskQuery } from "@/lib/pipeline/run-ask-query";
import { parsePatchLines, readRunError } from "@/lib/pipeline/patch-lines";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ask-error-"));
  setPathRoots({ dataRoot: dir, scratchRoot: join(dir, "scratch"), userRoot: join(dir, "user") });
});
afterEach(() => {
  setPathRoots({});
  rmSync(dir, { recursive: true, force: true });
});

describe("runAskQuery failure path", () => {
  it("emits /state/__error with the real message, beside the UI error spec", async () => {
    const lines: string[] = [];
    // No CSV stored under this id — the run fails before any LLM/sandbox work.
    const runId = await runPatchStream(
      "test:ask",
      { write: (d) => lines.push(d) },
      async (stream) => {
        await runAskQuery({
          context: {},
          question: "q",
          source: { kind: "csv", csvId: "missing-csv-id" },
          codeGenModel: "m",
          uiComposeModel: "m",
          sandboxRuntime: "docker",
          runState: { csvId: "missing-csv-id", question: "q" },
          stream,
        });
      }
    );
    expect(typeof runId).toBe("string");
    expect(runId.length).toBeGreaterThan(0);

    const patches = parsePatchLines(lines);
    // The typed channel carries the message both harness consumers read.
    expect(readRunError(patches)).toContain("CSV not found or expired");
    // The UI affordance is additive, not replaced.
    expect(patches.some((p) => p.path === "/root" && p.value === "error")).toBe(true);
    expect(patches.some((p) => p.path === "/elements/error")).toBe(true);
  });
});
