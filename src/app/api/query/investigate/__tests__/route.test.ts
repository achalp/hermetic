import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Contract tests for the /api/query/investigate POST handler.
 *
 * Scope: ONLY the request-validation / early-error branches that return
 * BEFORE any LLM / sandbox / storage / streaming work. All heavy transitive
 * imports are mocked so importing the route has no side effects.
 */

// ── Heavy / side-effectful modules the route imports ──────────────────────
vi.mock("@/lib/llm/investigate-planner", () => ({ generatePlan: vi.fn() }));
vi.mock("@/lib/pipeline/investigate-orchestrator", () => ({ runInvestigation: vi.fn() }));
vi.mock("@/lib/pipeline/orchestrator", () => ({ runPipeline: vi.fn() }));
vi.mock("@/lib/pipeline/dashboard-compose", () => ({ composeAndStreamDashboard: vi.fn() }));
vi.mock("@/lib/llm/followup-classifier", () => ({ classifyFollowupDepth: vi.fn() }));
vi.mock("@/lib/pipeline/auto-investigation-budget", () => ({
  tryConsumeAutoInvestigation: vi.fn(),
}));
vi.mock("@/lib/llm/investigate-composer", () => ({ composeInvestigation: vi.fn() }));
vi.mock("@/lib/llm/step-cell-composer", () => ({ composeStepCell: vi.fn() }));
vi.mock("@/lib/llm/finalize-spec-stream", () => ({ createSpecFinalizer: vi.fn() }));
vi.mock("@/lib/pipeline/artifacts-cache", () => ({
  cacheArtifacts: vi.fn(),
  getCachedArtifacts: vi.fn(),
}));
vi.mock("@/lib/pipeline/investigation-trace", () => ({
  buildInvestigationTrace: vi.fn(),
  successfulStepNos: vi.fn(),
}));
vi.mock("@/lib/pipeline/grounding", () => ({
  collectGroundedValues: vi.fn(),
  verifyGrounding: vi.fn(),
  extractCitedSteps: vi.fn(),
  extractPlaceholderCitedSteps: vi.fn(),
}));
vi.mock("@/lib/warehouse/sql-generation", () => ({ generateSQLWithRepair: vi.fn() }));

// CSV storage — getStoredCSV drives one of the 404 branches. Default: not found.
const getStoredCSV = vi.fn(() => null);
vi.mock("@/lib/csv/storage", () => ({
  getStoredCSV: () => getStoredCSV(),
  getCSVContent: vi.fn(),
  getGeoJSONContent: vi.fn(),
  isLocalFile: vi.fn(() => false),
  storeCSV: vi.fn(),
}));

// Warehouse storage — drives the warehouse 404 branches. Default: not found.
const getStoredWarehouse = vi.fn();
const getWarehouseConnector = vi.fn();
vi.mock("@/lib/warehouse/storage", () => ({
  getStoredWarehouse: (id: string) => getStoredWarehouse(id),
  getWarehouseConnector: (id: string) => getWarehouseConnector(id),
}));

// getActiveProvider gates Investigate (refuses local providers, 400 on throw).
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

import { POST } from "../route";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/query/investigate", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getActiveProvider.mockReturnValue("anthropic");
  getStoredCSV.mockReturnValue(null);
  getStoredWarehouse.mockReturnValue(undefined);
  getWarehouseConnector.mockReturnValue(undefined);
});

describe("POST /api/query/investigate — validation contract", () => {
  it("returns 400 when neither csv_id nor warehouse_id is provided", async () => {
    const res = await POST(makeRequest({ context: { question: "why?" } }));
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

  it("returns 400 when question is only whitespace (trimmed to empty)", async () => {
    const res = await POST(makeRequest({ context: { csv_id: "abc", question: "   " } }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("question is required");
  });

  it("returns 400 when getActiveProvider throws (no LLM configured)", async () => {
    getActiveProvider.mockImplementation(() => {
      throw new Error("No LLM configured");
    });
    const res = await POST(makeRequest({ context: { csv_id: "abc", question: "why?" } }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("No LLM configured");
  });

  it("returns 400 when the active provider is a local model (ollama)", async () => {
    getActiveProvider.mockReturnValue("ollama");
    const res = await POST(makeRequest({ context: { csv_id: "abc", question: "why?" } }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Investigate mode requires a cloud LLM provider");
  });

  it("returns 404 when warehouse_id is given but the warehouse is not found", async () => {
    getStoredWarehouse.mockReturnValue(undefined);
    const res = await POST(makeRequest({ context: { warehouse_id: "wh-1", question: "why?" } }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Warehouse not found or expired. Please reconnect.");
  });

  it("returns 404 when the warehouse exists but its connector is not found", async () => {
    getStoredWarehouse.mockReturnValue({ config: { type: "snowflake" }, tableSchemas: [] });
    getWarehouseConnector.mockReturnValue(undefined);
    const res = await POST(makeRequest({ context: { warehouse_id: "wh-1", question: "why?" } }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Warehouse connector not found");
  });

  it("returns 404 when csv_id is given but the CSV is not found", async () => {
    getStoredCSV.mockReturnValue(null);
    const res = await POST(makeRequest({ context: { csv_id: "missing", question: "why?" } }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("CSV not found or expired");
  });

  it("returns 400 on malformed JSON body (client fault, not a server error)", async () => {
    const req = new Request("http://localhost/api/query/investigate", {
      method: "POST",
      body: "{not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(typeof json.error).toBe("string");
  });
});
