import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/vizs/save — persist the current analysis as a saved viz. Gates:
 * malformed body 400, missing/expired CSV 404, missing generated code 404.
 * On success it delegates to saveVisualization (or saveNewVersion when a
 * parentVizId is present) and echoes { meta }.
 */
const getCachedCode = vi.fn();
const getCachedArtifacts = vi.fn();
const getStoredCSV = vi.fn();
const getCSVContent = vi.fn();
const getWorkbookManifest = vi.fn();
const saveVisualization = vi.fn();
const saveNewVersion = vi.fn();
vi.mock("@/lib/pipeline/code-cache", () => ({
  getCachedCode: (...a: unknown[]) => getCachedCode(...a),
}));
vi.mock("@/lib/pipeline/artifacts-cache", () => ({
  getCachedArtifacts: (...a: unknown[]) => getCachedArtifacts(...a),
}));
vi.mock("@/lib/csv/storage", () => ({
  getStoredCSV: (...a: unknown[]) => getStoredCSV(...a),
  getCSVContent: (...a: unknown[]) => getCSVContent(...a),
  getWorkbookManifest: (...a: unknown[]) => getWorkbookManifest(...a),
}));
vi.mock("@/lib/saved/storage", () => ({
  saveVisualization: (...a: unknown[]) => saveVisualization(...a),
  saveNewVersion: (...a: unknown[]) => saveNewVersion(...a),
}));
vi.mock("@/lib/saved/schema-compat", () => ({ schemaFingerprint: () => "fp-1" }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { POST } from "@/app/api/vizs/save/route";

const req = (b: unknown) =>
  new Request("http://x/api/vizs/save", { method: "POST", body: JSON.stringify(b) });
const stored = { schema: { source_type: "upload", filename: "data.csv", columns: [] } };
const goodBody = { csvId: "c1", spec: { root: {} }, question: "q" };

beforeEach(() => {
  vi.clearAllMocks();
  getStoredCSV.mockReturnValue(stored);
  getCSVContent.mockResolvedValue("a,b\n1,2");
  getWorkbookManifest.mockReturnValue(undefined);
  getCachedCode.mockReturnValue({ code: "print(1)" });
  getCachedArtifacts.mockReturnValue({ code: "print(1)" });
  saveVisualization.mockResolvedValue({ id: "v1", question: "q" });
  saveNewVersion.mockResolvedValue({ id: "v1", version: 2 });
});

describe("POST /api/vizs/save", () => {
  it("400s on a malformed body", async () => {
    const res = await POST(req({ csvId: 123, spec: {}, question: "q" }));
    expect(res.status).toBe(400);
    expect(saveVisualization).not.toHaveBeenCalled();
  });

  it("404s when the CSV is missing/expired", async () => {
    getStoredCSV.mockReturnValue(null);
    expect((await POST(req(goodBody))).status).toBe(404);
  });

  it("404s when no generated code is cached", async () => {
    getCachedCode.mockReturnValue(undefined);
    getCachedArtifacts.mockReturnValue(undefined);
    expect((await POST(req(goodBody))).status).toBe(404);
  });

  it("saves a fresh visualization and echoes the meta", async () => {
    const res = await POST(req(goodBody));
    expect(res.status).toBe(200);
    expect((await res.json()).meta).toEqual({ id: "v1", question: "q" });
    expect(saveVisualization).toHaveBeenCalledTimes(1);
    expect(saveNewVersion).not.toHaveBeenCalled();
  });

  it("saves a new version when a parentVizId is provided", async () => {
    const res = await POST(req({ ...goodBody, parentVizId: "parent1" }));
    expect(res.status).toBe(200);
    expect(saveNewVersion).toHaveBeenCalledTimes(1);
    expect(saveVisualization).not.toHaveBeenCalled();
  });
});
