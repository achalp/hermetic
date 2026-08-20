import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/vizs/[id]/rerun — re-run a saved viz against a freshly uploaded
 * file (multipart). Covers: no file (400), unsupported file type (400),
 * schema-incompatible → { schemaMatch:false }, compatible + exec success →
 * { schemaMatch:true } + new version, and exec failure → falls back to
 * schemaMatch:false.
 */
const loadSavedVisualization = vi.fn();
const saveNewVersion = vi.fn();
const schemasCompatible = vi.fn();
const executeSandbox = vi.fn();
const ensureWarmSandboxReady = vi.fn();
const rehydrateSpec = vi.fn();
const storeCSV = vi.fn();
vi.mock("uuid", () => ({ v4: () => "new-csv-id" }));
vi.mock("@/lib/saved/storage", () => ({
  loadSavedVisualization: (...a: unknown[]) => loadSavedVisualization(...a),
  saveNewVersion: (...a: unknown[]) => saveNewVersion(...a),
}));
vi.mock("@/lib/saved/schema-compat", () => ({
  schemasCompatible: (...a: unknown[]) => schemasCompatible(...a),
  schemaFingerprint: () => "fp-1",
}));
vi.mock("@/lib/sandbox", () => ({
  executeSandbox: (...a: unknown[]) => executeSandbox(...a),
  prepareWarmSandbox: vi.fn(),
}));
vi.mock("@/lib/sandbox/warm-sandbox", () => ({
  ensureWarmSandboxReady: (...a: unknown[]) => ensureWarmSandboxReady(...a),
}));
vi.mock("@/lib/run-context", () => ({
  getRunId: () => "run-1",
  runWithRunId: (fn: () => unknown) => fn(),
}));
vi.mock("@/lib/runtime-config", () => ({ getActiveSandboxRuntime: () => "docker" }));
vi.mock("@/lib/saved/rehydrate-spec", () => ({
  rehydrateSpec: (...a: unknown[]) => rehydrateSpec(...a),
}));
vi.mock("@/lib/csv/parser", () => ({
  parseCSV: () => ({ headers: ["a"], rowCount: 1, data: [] }),
  toCSVText: () => "a\n1",
}));
vi.mock("@/lib/csv/schema", () => ({
  extractSchema: () => ({ row_count: 1, columns: [{ name: "a" }] }),
}));
vi.mock("@/lib/csv/storage", () => ({
  storeCSV: (...a: unknown[]) => storeCSV(...a),
  storeGeoJSON: vi.fn(),
  storeWorkbookManifest: vi.fn(),
}));
vi.mock("@/lib/excel/parser", () => ({ parseExcelMeta: vi.fn(), sheetToCSV: vi.fn() }));
vi.mock("@/lib/geojson/parser", () => ({ parseGeoJSON: vi.fn(), isGeoJSONObject: () => false }));
vi.mock("@/lib/llm/prompts", () => ({ sanitizeSheetName: (s: string) => s }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { POST } from "@/app/api/vizs/[id]/rerun/route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
function upload(fileName: string, content = "a,b\n1,2"): Request {
  const fd = new FormData();
  fd.set("file", new File([content], fileName, { type: "text/csv" }));
  return new Request("http://x", { method: "POST", body: fd });
}
const savedViz = {
  meta: { csvFilename: "orig.csv", question: "q" },
  spec: { root: {} },
  artifacts: {},
  csvContent: "a,b\n1,2",
  generatedCode: "print(1)",
  workbook: undefined,
};

beforeEach(() => {
  vi.clearAllMocks();
  loadSavedVisualization.mockResolvedValue(savedViz);
  storeCSV.mockResolvedValue(undefined);
  ensureWarmSandboxReady.mockResolvedValue(undefined);
  schemasCompatible.mockReturnValue(true);
  executeSandbox.mockResolvedValue({
    success: true,
    results: {},
    chart_data: {},
    datasets: {},
    execution_ms: 3,
  });
  rehydrateSpec.mockReturnValue({ root: { r: true } });
  saveNewVersion.mockResolvedValue({ id: "v1", version: 2 });
});

describe("POST /api/vizs/[id]/rerun", () => {
  it("400s when no file is provided", async () => {
    const res = await POST(
      new Request("http://x", { method: "POST", body: new FormData() }),
      ctx("v1")
    );
    expect(res.status).toBe(400);
  });

  it("400s an unsupported file type", async () => {
    const res = await POST(upload("data.txt"), ctx("v1"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(".csv");
  });

  it("returns schemaMatch:false when the new schema is incompatible", async () => {
    schemasCompatible.mockReturnValue(false);
    const res = await POST(upload("data.csv"), ctx("v1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemaMatch).toBe(false);
    expect(body.csvId).toBe("new-csv-id");
    expect(saveNewVersion).not.toHaveBeenCalled();
  });

  it("re-executes and saves a new version on a compatible schema", async () => {
    const res = await POST(upload("data.csv"), ctx("v1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schemaMatch).toBe(true);
    expect(body.spec).toEqual({ root: { r: true } });
    expect(saveNewVersion).toHaveBeenCalledTimes(1);
  });

  it("falls back to schemaMatch:false when execution fails on the new data", async () => {
    executeSandbox.mockResolvedValue({ success: false, error: "boom" });
    const res = await POST(upload("data.csv"), ctx("v1"));
    const body = await res.json();
    expect(body.schemaMatch).toBe(false);
    expect(saveNewVersion).not.toHaveBeenCalled();
  });
});
