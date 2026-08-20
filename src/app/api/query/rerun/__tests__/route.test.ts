import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/query/rerun — edit-and-rerun of the Artifacts panel code. Gates:
 * csv_id required (400), code required (400), missing/expired source (404).
 * On success it runs the edited code, re-caches the artifacts, and returns
 * them; a pipeline throw maps to a 422.
 */
const getStoredCSV = vi.fn();
const getCSVContent = vi.fn();
const getGeoJSONContent = vi.fn();
const runPipelineWithCode = vi.fn();
const cacheArtifacts = vi.fn();
const getCachedArtifacts = vi.fn();
vi.mock("@/lib/csv/storage", () => ({
  getStoredCSV: (...a: unknown[]) => getStoredCSV(...a),
  getCSVContent: (...a: unknown[]) => getCSVContent(...a),
  getGeoJSONContent: (...a: unknown[]) => getGeoJSONContent(...a),
}));
vi.mock("@/lib/pipeline/orchestrator", () => ({
  runPipelineWithCode: (...a: unknown[]) => runPipelineWithCode(...a),
}));
vi.mock("@/lib/pipeline/artifacts-cache", () => ({
  cacheArtifacts: (...a: unknown[]) => cacheArtifacts(...a),
  getCachedArtifacts: (...a: unknown[]) => getCachedArtifacts(...a),
}));
vi.mock("@/lib/runtime-config", () => ({ getActiveSandboxRuntime: () => "docker" }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  errMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { POST } from "@/app/api/query/rerun/route";

const req = (b: unknown) =>
  new Request("http://x/api/query/rerun", { method: "POST", body: JSON.stringify(b) });

beforeEach(() => {
  vi.clearAllMocks();
  getStoredCSV.mockReturnValue({ schema: {} });
  getCSVContent.mockResolvedValue("a,b\n1,2");
  getGeoJSONContent.mockResolvedValue(null);
  getCachedArtifacts.mockReturnValue({ question: "orig q", sql: "SELECT 1" });
});

describe("POST /api/query/rerun", () => {
  it("400s without csv_id", async () => {
    expect((await POST(req({ code: "print(1)" }))).status).toBe(400);
  });

  it("400s without code", async () => {
    expect((await POST(req({ csv_id: "c1", code: "  " }))).status).toBe(400);
  });

  it("404s when the source is missing/expired", async () => {
    getStoredCSV.mockReturnValue(null);
    expect((await POST(req({ csv_id: "gone", code: "print(1)" }))).status).toBe(404);
  });

  it("runs the edited code and returns fresh artifacts", async () => {
    runPipelineWithCode.mockResolvedValue({
      executionResult: { results: { r: 1 }, chart_data: {}, datasets: {}, execution_ms: 5 },
    });
    const res = await POST(req({ csv_id: "c1", code: "print(1)" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.artifacts.results).toEqual({ r: 1 });
    expect(body.artifacts.question).toBe("orig q");
    expect(body.artifacts.sql).toBe("SELECT 1");
    expect(cacheArtifacts).toHaveBeenCalled();
  });

  it("maps a pipeline failure to a 422", async () => {
    runPipelineWithCode.mockRejectedValue(new Error("NameError"));
    const res = await POST(req({ csv_id: "c1", code: "print(1)" }));
    expect(res.status).toBe(422);
  });
});
