import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /api/history/[id] — GET restores a persisted entry (uploaded source path:
 * re-parse CSV into the store, seed conversation + artifacts caches) and 404s
 * on a load failure. DELETE removes the entry. Storage/parse/cache seams
 * mocked so no real I/O runs.
 */
const loadHistoryEntry = vi.fn();
const deleteHistoryEntry = vi.fn();
const storeCSV = vi.fn();
const registerRemoteRefFromEntry = vi.fn();
const appendConversationTurn = vi.fn();
const cacheArtifacts = vi.fn();
vi.mock("uuid", () => ({ v4: () => "fresh-csv-id" }));
vi.mock("node:fs/promises", () => ({ stat: vi.fn() }));
vi.mock("@/lib/history/storage", () => ({
  loadHistoryEntry: (...a: unknown[]) => loadHistoryEntry(...a),
  deleteHistoryEntry: (...a: unknown[]) => deleteHistoryEntry(...a),
}));
vi.mock("@/lib/csv/storage", () => ({
  storeCSV: (...a: unknown[]) => storeCSV(...a),
  storeLocalFileRef: vi.fn(),
}));
vi.mock("@/lib/history/rehydrate-source", () => ({
  registerRemoteRefFromEntry: (...a: unknown[]) => registerRemoteRefFromEntry(...a),
}));
vi.mock("@/lib/csv/parser", () => ({ parseCSV: () => ({ data: [] }) }));
vi.mock("@/lib/csv/schema", () => ({
  extractSchema: () => ({ row_count: 1, columns: [{ name: "a" }] }),
}));
vi.mock("@/lib/pipeline/conversation-cache", () => ({
  appendConversationTurn: (...a: unknown[]) => appendConversationTurn(...a),
  buildTurnFromArtifacts: () => ({ turn: 1 }),
}));
vi.mock("@/lib/pipeline/artifacts-cache", () => ({
  cacheArtifacts: (...a: unknown[]) => cacheArtifacts(...a),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { GET, DELETE } from "@/app/api/history/[id]/route";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  storeCSV.mockResolvedValue(undefined);
  registerRemoteRefFromEntry.mockResolvedValue(false);
});

describe("GET /api/history/[id]", () => {
  it("restores an uploaded-source entry and seeds the caches", async () => {
    loadHistoryEntry.mockResolvedValue({
      meta: { sourceFile: "data.csv", question: "q" },
      spec: { root: {} },
      artifacts: { code: "print(1)" },
      schema: { columns: [{ name: "a" }] },
      csvContent: "a,b\n1,2",
    });
    const res = await GET(new Request("http://x"), ctx("h1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.csvId).toBe("fresh-csv-id");
    expect(storeCSV).toHaveBeenCalled();
    expect(appendConversationTurn).toHaveBeenCalled();
    expect(cacheArtifacts).toHaveBeenCalled();
  });

  it("404s when the entry cannot be loaded", async () => {
    loadHistoryEntry.mockRejectedValue(new Error("no such entry"));
    const res = await GET(new Request("http://x"), ctx("gone"));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/history/[id]", () => {
  it("deletes the entry", async () => {
    deleteHistoryEntry.mockResolvedValue(undefined);
    const res = await DELETE(new Request("http://x"), ctx("h1"));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(deleteHistoryEntry).toHaveBeenCalledWith("h1");
  });

  it("500s when the delete throws", async () => {
    deleteHistoryEntry.mockRejectedValue(new Error("locked"));
    const res = await DELETE(new Request("http://x"), ctx("h1"));
    expect(res.status).toBe(500);
  });
});
