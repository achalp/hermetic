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
vi.mock("ai", () => ({ generateText: vi.fn() }));
vi.mock("@/lib/llm/client", () => ({
  getModel: vi.fn(() => ({}) as never),
  cachedSystem: vi.fn((s: string) => s),
}));
vi.mock("@/lib/diagnostics/failure-log", () => ({ recordFailure: vi.fn(async () => {}) }));

import { runPipeline } from "@/lib/pipeline/orchestrator";
import { generateAnalysisCode } from "@/lib/llm/code-generation";
import { executeSandbox } from "@/lib/sandbox";
import { generateText } from "ai";
import type { CSVSchema } from "@/lib/types";

const mockedGen = vi.mocked(generateAnalysisCode);
const mockedExec = vi.mocked(executeSandbox);
const mockedRetryLlm = vi.mocked(generateText);

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
  mockedRetryLlm.mockResolvedValue({ text: "print('fixed')" } as never);
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
    await expect(runPipeline(schema, "csv", "q")).rejects.toThrow(/failed after 3 retries/i);
    // 1 initial + 3 retries executed
    expect(mockedExec).toHaveBeenCalledTimes(4);
    expect(mockedRetryLlm).toHaveBeenCalledTimes(3);
  });

  it("fails fast on a sandbox timeout — no retry (regenerating just times out again)", async () => {
    mockedExec.mockResolvedValue(fail("Sandbox execution timed out after 1200000ms"));
    await expect(runPipeline(schema, "csv", "q")).rejects.toThrow(/timed out/i);
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
    mockedRetryLlm.mockRejectedValue(new Error("Cannot connect to API"));
    await expect(runPipeline(schema, "csv", "q")).rejects.toThrow(
      /retry LLM call also failed[\s\S]*KeyError[\s\S]*Cannot connect/
    );
  });
});
