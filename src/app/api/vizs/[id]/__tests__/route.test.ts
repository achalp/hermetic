import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /api/vizs/[id] — GET restores a saved viz: re-parses the CSV into the
 * in-memory store, warms a sandbox, and seeds the conversation cache; a load
 * failure 404s. DELETE removes the saved viz. All storage/parse/sandbox seams
 * are mocked so no real I/O runs.
 */
const loadSavedVisualization = vi.fn();
const deleteSavedVisualization = vi.fn();
const storeCSV = vi.fn();
const prepareWarmSandbox = vi.fn();
const appendConversationTurn = vi.fn();
vi.mock("uuid", () => ({ v4: () => "fresh-csv-id" }));
vi.mock("@/lib/saved/storage", () => ({
  loadSavedVisualization: (...a: unknown[]) => loadSavedVisualization(...a),
  deleteSavedVisualization: (...a: unknown[]) => deleteSavedVisualization(...a),
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
  storeWorkbookManifest: vi.fn(),
}));
vi.mock("@/lib/llm/prompts", () => ({ sanitizeSheetName: (s: string) => s }));
vi.mock("@/lib/sandbox", () => ({
  prepareWarmSandbox: (...a: unknown[]) => prepareWarmSandbox(...a),
}));
vi.mock("@/lib/runtime-config", () => ({ getActiveSandboxRuntime: () => "docker" }));
vi.mock("@/lib/pipeline/conversation-cache", () => ({
  appendConversationTurn: (...a: unknown[]) => appendConversationTurn(...a),
  buildTurnFromArtifacts: () => ({ turn: 1 }),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { GET, DELETE } from "@/app/api/vizs/[id]/route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  storeCSV.mockResolvedValue(undefined);
});

describe("GET /api/vizs/[id]", () => {
  it("restores a single-sheet viz into the store and warms a sandbox", async () => {
    loadSavedVisualization.mockResolvedValue({
      meta: { csvFilename: "data.csv", question: "q" },
      spec: { root: {} },
      artifacts: { code: "print(1)" },
      csvContent: "a,b\n1,2",
    });
    const res = await GET(new Request("http://x"), ctx("v1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.csvId).toBe("fresh-csv-id");
    expect(body.spec).toEqual({ root: {} });
    expect(storeCSV).toHaveBeenCalled();
    expect(prepareWarmSandbox).toHaveBeenCalled();
    expect(appendConversationTurn).toHaveBeenCalled();
  });

  it("404s when the saved viz cannot be loaded", async () => {
    loadSavedVisualization.mockRejectedValue(new Error("not found"));
    const res = await GET(new Request("http://x"), ctx("gone"));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/vizs/[id]", () => {
  it("deletes the saved viz", async () => {
    deleteSavedVisualization.mockResolvedValue(undefined);
    const res = await DELETE(new Request("http://x"), ctx("v1"));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(deleteSavedVisualization).toHaveBeenCalledWith("v1");
  });

  it("500s when the delete throws", async () => {
    deleteSavedVisualization.mockRejectedValue(new Error("locked"));
    const res = await DELETE(new Request("http://x"), ctx("v1"));
    expect(res.status).toBe(500);
  });
});
