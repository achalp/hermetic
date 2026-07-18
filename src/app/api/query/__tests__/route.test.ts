import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Contract tests for the /api/query POST handler.
 *
 * Scope: ONLY the request-validation / early-error branches that return
 * BEFORE any LLM / sandbox / storage / streaming work. The heavy transitive
 * imports are mocked so importing the route has no side effects and the real
 * pipeline never runs.
 */

// ── Heavy / side-effectful modules the route imports ──────────────────────
// Mocked to no-ops so `import` of the route is safe and validation branches
// are reachable without touching LLM clients, sandboxes, or real storage.
vi.mock("@/lib/pipeline/orchestrator", () => ({
  runPipeline: vi.fn(),
  runPipelineWithCode: vi.fn(),
}));
vi.mock("@/lib/pipeline/dashboard-compose", () => ({
  composeAndStreamDashboard: vi.fn(),
}));
vi.mock("@/lib/pipeline/code-cache", () => ({ cacheGeneratedCode: vi.fn() }));
vi.mock("@/lib/pipeline/artifacts-cache", () => ({ cacheArtifacts: vi.fn() }));
vi.mock("@/lib/pipeline/conversation-cache", () => ({
  getConversationTurns: vi.fn(() => []),
  appendConversationTurn: vi.fn(),
  buildTurnFromArtifacts: vi.fn(),
}));
vi.mock("@/lib/csv/storage", () => ({
  getStoredCSV: vi.fn(() => null),
  getCSVContent: vi.fn(),
  getGeoJSONContent: vi.fn(),
  getWorkbookManifest: vi.fn(),
  storeCSV: vi.fn(),
  isLocalFile: vi.fn(() => false),
}));
vi.mock("@/lib/warehouse/sql-generation", () => ({ generateSQL: vi.fn() }));
vi.mock("@/lib/llm/prompts", () => ({
  buildWorkbookContext: vi.fn(),
  sanitizeSheetName: vi.fn(),
}));

// getActiveProvider is called (in a try/catch) before validation. Default to
// a benign cloud provider so it doesn't throw.
const getActiveProvider = vi.fn(() => "anthropic");
vi.mock("@/lib/llm/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/client")>();
  return {
    ...actual,
    getActiveProvider: () => getActiveProvider(),
    // providerCapabilities is pure — keep the real one so the capability
    // contract (not a mock of it) is what these route tests exercise.
  };
});

// Warehouse storage — the 404 branches read these. Default: not found.
const getStoredWarehouse = vi.fn();
const getWarehouseConnector = vi.fn();
vi.mock("@/lib/warehouse/storage", () => ({
  getStoredWarehouse: (id: string) => getStoredWarehouse(id),
  getWarehouseConnector: (id: string) => getWarehouseConnector(id),
}));

import { POST } from "../route";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/query", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getActiveProvider.mockReturnValue("anthropic");
  getStoredWarehouse.mockReturnValue(undefined);
  getWarehouseConnector.mockReturnValue(undefined);
});

describe("POST /api/query — validation contract", () => {
  it("returns 400 when neither csv_id nor warehouse_id is provided", async () => {
    const res = await POST(makeRequest({ context: { question: "hi" } }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("csv_id or warehouse_id is required in context");
  });

  it("returns 400 when context is entirely absent", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("csv_id or warehouse_id is required in context");
  });

  it("returns 400 when csv_id is present but question is missing", async () => {
    const res = await POST(makeRequest({ context: { csv_id: "abc" } }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("question is required");
  });

  it("returns 404 when warehouse_id is given but the warehouse is not found", async () => {
    getStoredWarehouse.mockReturnValue(undefined);
    const res = await POST(makeRequest({ context: { warehouse_id: "wh-1", question: "trend?" } }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Warehouse not found or expired. Please reconnect.");
  });

  it("returns 404 when the warehouse exists but its connector is not found", async () => {
    getStoredWarehouse.mockReturnValue({ config: { type: "snowflake" }, tableSchemas: [] });
    getWarehouseConnector.mockReturnValue(undefined);
    const res = await POST(makeRequest({ context: { warehouse_id: "wh-1", question: "trend?" } }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Warehouse connector not found");
  });

  it("returns 400 on malformed JSON body (client fault, not a server error)", async () => {
    const req = new Request("http://localhost/api/query", {
      method: "POST",
      body: "{not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(typeof json.error).toBe("string");
  });
});
