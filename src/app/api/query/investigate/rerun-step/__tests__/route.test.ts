import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/query/investigate/rerun-step — re-run one investigation step.
 * Covers the validation ladder (csv_id, step_index, cached trail, step lookup,
 * removed step, empty code, expired data), the success path (execute → compose
 * cell → persist frame → update trail → return dependents), and a pipeline
 * failure → 422.
 */
const getStoredCSV = vi.fn();
const getCSVContent = vi.fn();
const getGeoJSONContent = vi.fn();
const isLocalFile = vi.fn();
const storeCSV = vi.fn();
const runPipelineWithCode = vi.fn();
const cacheArtifacts = vi.fn();
const getCachedArtifacts = vi.fn();
const composeStepCell = vi.fn();
const transitiveDependents = vi.fn();
const primaryFrameCsv = vi.fn();
vi.mock("@/lib/csv/storage", () => ({
  getStoredCSV: (...a: unknown[]) => getStoredCSV(...a),
  getCSVContent: (...a: unknown[]) => getCSVContent(...a),
  getGeoJSONContent: (...a: unknown[]) => getGeoJSONContent(...a),
  isLocalFile: (...a: unknown[]) => isLocalFile(...a),
  storeCSV: (...a: unknown[]) => storeCSV(...a),
}));
vi.mock("@/lib/pipeline/orchestrator", () => ({
  runPipelineWithCode: (...a: unknown[]) => runPipelineWithCode(...a),
}));
vi.mock("@/lib/pipeline/artifacts-cache", () => ({
  cacheArtifacts: (...a: unknown[]) => cacheArtifacts(...a),
  getCachedArtifacts: (...a: unknown[]) => getCachedArtifacts(...a),
}));
vi.mock("@/lib/pipeline/investigation-trace", () => ({
  capDatasets: (d: unknown) => d,
  transitiveDependents: (...a: unknown[]) => transitiveDependents(...a),
}));
vi.mock("@/lib/llm/step-cell-composer", () => ({
  composeStepCell: (...a: unknown[]) => composeStepCell(...a),
}));
vi.mock("@/lib/pipeline/step-frames", () => ({
  buildStepFrames: () => ({ files: [] }),
  primaryFrameCsv: (...a: unknown[]) => primaryFrameCsv(...a),
  stepFramePath: (n: number) => `/data/step_${n}.csv`,
}));
vi.mock("@/lib/csv/parser", () => ({ parseCSV: () => ({ data: [] }) }));
vi.mock("@/lib/csv/schema", () => ({ extractSchema: () => ({ columns: [] }) }));
vi.mock("crypto", () => ({ randomUUID: () => "frame-uuid" }));
vi.mock("@/lib/constants", () => ({ LOCAL_MOUNT_PATH: "/data/local" }));
vi.mock("@/lib/runtime-config", () => ({
  getActiveSandboxRuntime: () => "docker",
  getActiveModels: () => ({ uiCompose: "claude-test" }),
}));
vi.mock("@/lib/cost/epilogue", () => ({
  trackRouteCost: (_m: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  errMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { POST } from "@/app/api/query/investigate/rerun-step/route";

const req = (b: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(b) });
const step = {
  index: 0,
  stepNo: 1,
  question: "q1",
  rationale: "r",
  depends_on: [] as number[],
  status: "success",
  code: "print(1)",
};
const trace = { originalQuestion: "why?", approach: "explore", steps: [step] };

beforeEach(() => {
  vi.clearAllMocks();
  getCachedArtifacts.mockReturnValue({ investigation: trace });
  getStoredCSV.mockReturnValue({ schema: { has_geojson: false } });
  getCSVContent.mockResolvedValue("a,b\n1,2");
  isLocalFile.mockReturnValue(false);
  runPipelineWithCode.mockResolvedValue({
    executionResult: { results: { r: 1 }, chart_data: {}, datasets: {}, execution_ms: 4 },
  });
  composeStepCell.mockResolvedValue({ cell: "spec" });
  primaryFrameCsv.mockReturnValue("a\n1");
  storeCSV.mockResolvedValue(undefined);
  transitiveDependents.mockReturnValue([1, 2]);
});

describe("POST /api/query/investigate/rerun-step", () => {
  it("400s without a csv_id", async () => {
    expect((await POST(req({ step_index: 0 }))).status).toBe(400);
  });

  it("400s on a non-integer step_index", async () => {
    expect((await POST(req({ csv_id: "c1", step_index: -1 }))).status).toBe(400);
  });

  it("404s when no trail is cached", async () => {
    getCachedArtifacts.mockReturnValue({ investigation: undefined });
    expect((await POST(req({ csv_id: "c1", step_index: 0 }))).status).toBe(404);
  });

  it("404s when the step index is not in the trail", async () => {
    expect((await POST(req({ csv_id: "c1", step_index: 9 }))).status).toBe(404);
  });

  it("400s when the step was removed by the re-planner", async () => {
    getCachedArtifacts.mockReturnValue({
      investigation: { ...trace, steps: [{ ...step, status: "removed" }] },
    });
    expect((await POST(req({ csv_id: "c1", step_index: 0 }))).status).toBe(400);
  });

  it("400s when the step has no code", async () => {
    getCachedArtifacts.mockReturnValue({
      investigation: { ...trace, steps: [{ ...step, code: "" }] },
    });
    expect((await POST(req({ csv_id: "c1", step_index: 0 }))).status).toBe(400);
  });

  it("404s when the source data has expired", async () => {
    getStoredCSV.mockReturnValue(null);
    expect((await POST(req({ csv_id: "c1", step_index: 0 }))).status).toBe(404);
  });

  it("re-runs the step, updates the trail, and returns dependents", async () => {
    const res = await POST(req({ csv_id: "c1", step_index: 0 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.step.status).toBe("success");
    expect(body.step.outputCsvId).toBe("frame-uuid");
    expect(body.dependents).toEqual([1, 2]);
    expect(cacheArtifacts).toHaveBeenCalled();
  });

  it("maps a pipeline failure to a 422", async () => {
    runPipelineWithCode.mockRejectedValue(new Error("NameError"));
    const res = await POST(req({ csv_id: "c1", step_index: 0 }));
    expect(res.status).toBe(422);
  });
});
