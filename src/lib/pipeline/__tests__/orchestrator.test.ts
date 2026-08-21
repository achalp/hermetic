/**
 * runPipeline retry-loop tests — the app's main self-healing mechanism
 * (code-gen → sandbox → up-to-3 retries with full failure history, semantic
 * validation with a 1-retry budget, timeout fail-fast, degraded returns).
 * Mirrors the investigate-orchestrator test approach: mock the LLM and the
 * sandbox at their module boundaries, drive the loop with scripted outcomes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/llm/code-generation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/code-generation")>();
  return { ...actual, generateAnalysisCode: vi.fn() };
});
vi.mock("@/lib/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sandbox")>();
  return { ...actual, executeSandbox: vi.fn() };
});
vi.mock("ai", () => ({ generateText: vi.fn(), streamText: vi.fn() }));
vi.mock("@/lib/llm/client", () => ({
  getModel: vi.fn(() => ({}) as never),
  cachedSystem: vi.fn((s: string) => s),
}));
vi.mock("@/lib/diagnostics/failure-log", () => ({ recordFailure: vi.fn(async () => {}) }));

import { runPipeline } from "@/lib/pipeline/orchestrator";
import { generateAnalysisCode } from "@/lib/llm/code-generation";
import { executeSandbox } from "@/lib/sandbox";
import { streamText } from "ai";
import type { CSVSchema } from "@/lib/contracts/data-schema";

const mockedGen = vi.mocked(generateAnalysisCode);
const mockedExec = vi.mocked(executeSandbox);
// The retry path uses streamText (returns { text: Promise<string> }).
const mockedRetryLlm = vi.mocked(streamText);

const schema: CSVSchema = {
  csv_id: "csv-1",
  filename: "sales.csv",
  row_count: 100,
  columns: [
    { name: "region", dtype: "string", sample_values: ["West"] },
    { name: "revenue", dtype: "number", sample_values: ["12"] },
  ],
  sample_rows: [],
  detected_domain: "general",
  source_type: "file",
} as unknown as CSVSchema;

const ok = (results: Record<string, unknown> = { total: 42 }) => ({
  success: true as const,
  results,
  chart_data: { main: [{ x: 1, y: 2 }] },
  images: {},
  datasets: {},
  execution_ms: 5,
});

const fail = (error: string) => ({ success: false as const, error, execution_ms: 5 });

beforeEach(() => {
  vi.clearAllMocks();
  mockedGen.mockResolvedValue("print('v1')");
  // Retry LLM always returns fixed code.
  mockedRetryLlm.mockReturnValue({ text: Promise.resolve("print('fixed')") } as never);
});

describe("runPipeline retry loop", () => {
  it("returns immediately on first-attempt success (no retry LLM call)", async () => {
    mockedExec.mockResolvedValueOnce(ok());
    const result = await runPipeline(schema, "csv", "total?");
    expect(result.executionResult.success).toBe(true);
    expect(result.generatedCode).toBe("print('v1')");
    expect(mockedRetryLlm).not.toHaveBeenCalled();
  });

  it("retries an execution failure and succeeds with the fixed code", async () => {
    mockedExec
      .mockResolvedValueOnce(fail("NameError: x is not defined"))
      .mockResolvedValueOnce(ok());
    const stages: string[] = [];
    const result = await runPipeline(schema, "csv", "q", { onStage: (s) => stages.push(s) });
    expect(result.executionResult.success).toBe(true);
    expect(result.generatedCode).toBe("print('fixed')");
    expect(mockedRetryLlm).toHaveBeenCalledTimes(1);
    expect(stages).toContain("retrying");
    // The retry prompt carries the prior attempt's code + error history.
    const retryArgs = mockedRetryLlm.mock.calls[0][0] as { prompt: string };
    expect(retryArgs.prompt).toContain("NameError");
  });

  it("throws after exhausting MAX_RETRIES (3) on persistent execution failure", async () => {
    mockedExec.mockResolvedValue(fail("boom"));
    // 1 initial + 3 retries = 4 attempts (the message reports the real count,
    // not the constant MAX_RETRIES — a timeout fail-fast runs only 1).
    await expect(runPipeline(schema, "csv", "q")).rejects.toThrow(/failed after 4 attempts/i);
    expect(mockedExec).toHaveBeenCalledTimes(4);
    expect(mockedRetryLlm).toHaveBeenCalledTimes(3);
  });

  it("fails fast on a sandbox timeout — no retry (regenerating just times out again)", async () => {
    mockedExec.mockResolvedValue(fail("Sandbox execution timed out after 1200000ms"));
    await expect(runPipeline(schema, "csv", "q")).rejects.toThrow(/timed out/i);
    expect(mockedRetryLlm).not.toHaveBeenCalled();
    expect(mockedExec).toHaveBeenCalledTimes(1);
  });

  it("fail-fast keys on errorKind:'timeout' — survives a reworded message (CORE-7)", async () => {
    // The structured kind, NOT the message text, drives the decision: a
    // future reword of docker's timeout message must not re-enable retries.
    mockedExec.mockResolvedValue({
      success: false as const,
      error: "Execution exceeded the budget", // no "timed out" substring
      errorKind: "timeout" as const,
      execution_ms: 5,
    });
    const err = (await runPipeline(schema, "csv", "q").catch((e) => e)) as Error;
    expect(err.message).toMatch(/exceeded the budget/i);
    // The headline must name it a timeout-not-retried, NOT "failed after N
    // attempts" — the message that misled a real post-mortem.
    expect(err.message).toMatch(/timed out and was not retried/i);
    expect(err.message).not.toMatch(/failed after/i);
    expect(mockedRetryLlm).not.toHaveBeenCalled();
    expect(mockedExec).toHaveBeenCalledTimes(1);
  });

  it("a user Stop surfaces as the plain stop message, never 'failed after N attempts' (L3 backlog #5)", async () => {
    mockedExec.mockResolvedValue({
      success: false as const,
      error: "Analysis stopped.",
      errorKind: "stopped" as const,
      execution_ms: 5,
    });
    const err = (await runPipeline(schema, "csv", "q").catch((e) => e)) as Error;
    expect(err.message).toBe("Analysis stopped.");
    expect(err.message).not.toMatch(/failed after/i);
    expect(err.message).not.toMatch(/attempt/i);
    // A cancellation never re-runs the user's just-cancelled work.
    expect(mockedRetryLlm).not.toHaveBeenCalled();
    expect(mockedExec).toHaveBeenCalledTimes(1);
  });

  it("gives a semantically-empty result ONE fix attempt, then returns degraded", async () => {
    // Empty results + empty chart_data + empty datasets = degenerate verdict.
    const empty = {
      success: true as const,
      results: {},
      chart_data: {},
      images: {},
      datasets: {},
      execution_ms: 5,
    };
    mockedExec.mockResolvedValue(empty);
    const result = await runPipeline(schema, "csv", "q");
    // One semantic retry, then accepted as degraded — NOT thrown.
    expect(mockedRetryLlm).toHaveBeenCalledTimes(1);
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toBeTruthy();
  });

  it("surfaces the underlying LLM error when the retry call itself fails", async () => {
    mockedExec.mockResolvedValue(fail("KeyError: 'colX'"));
    mockedRetryLlm.mockImplementation(
      () => ({ text: Promise.reject(new Error("Cannot connect to API")) }) as never
    );
    await expect(runPipeline(schema, "csv", "q")).rejects.toThrow(
      /retry LLM call also failed[\s\S]*KeyError[\s\S]*Cannot connect/
    );
  });
});
