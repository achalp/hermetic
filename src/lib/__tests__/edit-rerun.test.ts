/**
 * Tests for the edit-and-rerun pipeline.
 *
 * `runPipelineWithCode` is the new orchestrator helper that skips code-gen
 * and runs only the sandbox-execution step. We mock the sandbox so we
 * don't need Docker / E2B / microsandbox to run the test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeSandboxMock } = vi.hoisted(() => ({
  executeSandboxMock: vi.fn(),
}));

vi.mock("@/lib/sandbox", () => ({
  executeSandbox: executeSandboxMock,
}));

import { runPipelineWithCode } from "@/lib/pipeline/orchestrator";

beforeEach(() => {
  executeSandboxMock.mockReset();
});

describe("runPipelineWithCode", () => {
  it("calls executeSandbox once with the provided code (no LLM call)", async () => {
    executeSandboxMock.mockResolvedValue({
      success: true,
      results: { total: 100 },
      chart_data: { main: [{ x: 1, y: 2 }] },
      images: {},
      datasets: {},
      execution_ms: 42,
    });

    const result = await runPipelineWithCode("print('hello')", "a,b\n1,2\n", "what is the total?", {
      csvId: "csv-123",
    });

    expect(executeSandboxMock).toHaveBeenCalledTimes(1);
    expect(executeSandboxMock).toHaveBeenCalledWith(
      "a,b\n1,2\n",
      "print('hello')",
      expect.objectContaining({ csvId: "csv-123" })
    );
    expect(result.executionResult.success).toBe(true);
    expect(result.generatedCode).toBe("print('hello')");
    expect(result.question).toBe("what is the total?");
  });

  it("does NOT retry on failure (unlike runPipeline)", async () => {
    executeSandboxMock.mockResolvedValue({
      success: false,
      error: "NameError: name 'undefined_var' is not defined",
      execution_ms: 10,
    });

    await expect(runPipelineWithCode("oops", "a,b\n1,2\n", "broken", {})).rejects.toThrow(
      /NameError/
    );
    expect(executeSandboxMock).toHaveBeenCalledTimes(1); // no retry
  });

  it("forwards runtime, geojsonContent, additionalFiles, localMountPath, inputParquetPath", async () => {
    executeSandboxMock.mockResolvedValue({
      success: true,
      results: {},
      chart_data: {},
      images: {},
      datasets: {},
      execution_ms: 0,
    });

    const additionalFiles = [{ path: "/data/extra.csv", filename: "extra.csv", content: "x,y\n" }];
    await runPipelineWithCode("ok", "a\n1\n", "q", {
      runtime: "docker",
      geojsonContent: '{"type":"FeatureCollection"}',
      additionalFiles,
      csvId: "id",
      localMountPath: "/data/local/foo.parquet",
      inputParquetPath: "/tmp/materialized.parquet",
    });

    expect(executeSandboxMock).toHaveBeenCalledWith(
      "a\n1\n",
      "ok",
      expect.objectContaining({
        runtime: "docker",
        geojsonContent: '{"type":"FeatureCollection"}',
        additionalFiles,
        csvId: "id",
        localMountPath: "/data/local/foo.parquet",
        inputParquetPath: "/tmp/materialized.parquet",
      })
    );
  });

  it("falls back to a generic error message if sandbox returns success:false with no error", async () => {
    executeSandboxMock.mockResolvedValue({
      success: false,
      error: "",
      execution_ms: 0,
    });
    await expect(runPipelineWithCode("x", "csv", "q", {})).rejects.toThrow(
      /Edited code failed to execute/
    );
  });
});
