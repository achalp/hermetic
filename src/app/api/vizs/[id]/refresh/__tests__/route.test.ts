import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/vizs/[id]/refresh — re-run a saved viz without LLM calls. Covers
 * the upload path end-to-end (store CSV → warm sandbox → execute → rehydrate →
 * save history), the warehouse pre-flight gates (missing SQL / missing
 * connection), and a sandbox execution failure → 500.
 */
const loadSavedVisualization = vi.fn();
const executeSandbox = vi.fn();
const ensureWarmSandboxReady = vi.fn();
const rehydrateSpec = vi.fn();
const saveHistoryEntry = vi.fn();
const storeCSV = vi.fn();
const getWarehouseConnector = vi.fn();
vi.mock("uuid", () => ({ v4: () => "fresh-csv-id" }));
vi.mock("fs/promises", () => ({ stat: vi.fn() }));
vi.mock("@/lib/saved/storage", () => ({
  loadSavedVisualization: (...a: unknown[]) => loadSavedVisualization(...a),
}));
vi.mock("@/lib/saved/rehydrate-spec", () => ({
  rehydrateSpec: (...a: unknown[]) => rehydrateSpec(...a),
}));
vi.mock("@/lib/sandbox", () => ({ executeSandbox: (...a: unknown[]) => executeSandbox(...a) }));
vi.mock("@/lib/run-context", () => ({
  getRunId: () => "run-1",
  runWithRunId: (fn: () => unknown) => fn(),
}));
vi.mock("@/lib/sandbox/warm-sandbox", () => ({
  ensureWarmSandboxReady: (...a: unknown[]) => ensureWarmSandboxReady(...a),
}));
vi.mock("@/lib/runtime-config", () => ({ getActiveSandboxRuntime: () => "docker" }));
vi.mock("@/lib/warehouse/storage", () => ({
  getWarehouseConnector: (...a: unknown[]) => getWarehouseConnector(...a),
}));
vi.mock("@/lib/csv/parser", () => ({
  parseCSV: () => ({ data: [] }),
  toCSVText: () => "a,b\n1,2",
}));
vi.mock("@/lib/csv/schema", () => ({
  extractSchema: () => ({ row_count: 1, columns: [{ name: "a" }] }),
}));
vi.mock("@/lib/csv/storage", () => ({
  storeCSV: (...a: unknown[]) => storeCSV(...a),
  storeLocalFileRef: vi.fn(),
}));
vi.mock("@/lib/history/storage", () => ({
  saveHistoryEntry: (...a: unknown[]) => saveHistoryEntry(...a),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { POST } from "@/app/api/vizs/[id]/refresh/route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = (b: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(b) });
const uploadViz = {
  meta: { sourceType: "upload", csvFilename: "data.csv", question: "q" },
  spec: { root: {} },
  artifacts: { sql: undefined },
  csvContent: "a,b\n1,2",
  generatedCode: "print(1)",
};
const execOk = {
  success: true,
  results: { r: 1 },
  chart_data: {},
  datasets: {},
  execution_ms: 12,
};

beforeEach(() => {
  vi.clearAllMocks();
  loadSavedVisualization.mockResolvedValue(uploadViz);
  storeCSV.mockResolvedValue(undefined);
  ensureWarmSandboxReady.mockResolvedValue(undefined);
  executeSandbox.mockResolvedValue(execOk);
  rehydrateSpec.mockReturnValue({ root: { refreshed: true } });
  saveHistoryEntry.mockResolvedValue({ id: "hist-1" });
});

describe("POST /api/vizs/[id]/refresh", () => {
  it("refreshes an uploaded-source viz and saves a new history entry", async () => {
    const res = await POST(req({}), ctx("v1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.historyId).toBe("hist-1");
    expect(body.spec).toEqual({ root: { refreshed: true } });
    expect(body.executionMs).toBe(12);
    expect(executeSandbox).toHaveBeenCalled();
    expect(ensureWarmSandboxReady).toHaveBeenCalled();
  });

  it("500s when sandbox execution fails", async () => {
    executeSandbox.mockResolvedValue({ success: false, error: "boom" });
    const res = await POST(req({}), ctx("v1"));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain("boom");
  });

  it("400s a warehouse refresh with no saved SQL", async () => {
    loadSavedVisualization.mockResolvedValue({
      ...uploadViz,
      meta: { ...uploadViz.meta, sourceType: "warehouse", sql: undefined },
      artifacts: {},
    });
    const res = await POST(req({}), ctx("v1"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("No SQL");
  });

  it("400s a warehouse refresh with no warehouse connection id", async () => {
    loadSavedVisualization.mockResolvedValue({
      ...uploadViz,
      meta: { ...uploadViz.meta, sourceType: "warehouse", sql: "SELECT 1" },
    });
    const res = await POST(req({}), ctx("v1"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("connection required");
  });

  it("404s a warehouse refresh when the connector is gone", async () => {
    loadSavedVisualization.mockResolvedValue({
      ...uploadViz,
      meta: { ...uploadViz.meta, sourceType: "warehouse", sql: "SELECT 1" },
    });
    getWarehouseConnector.mockReturnValue(null);
    const res = await POST(req({ warehouseId: "w1" }), ctx("v1"));
    expect(res.status).toBe(404);
  });
});
