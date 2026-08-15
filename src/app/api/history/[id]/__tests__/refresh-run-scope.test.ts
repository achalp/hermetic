import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Finding 03: the refresh route calls getRunId() to label the sandbox container
 * and the cost row, but nothing entered a run scope — so getRunId() always
 * returned undefined and the run_id was silently empty. The handler is now
 * wrapped in runWithRunId; this proves executeSandbox receives a real 8-hex
 * runId. run-context is NOT mocked (it is the code under test); everything else
 * is stubbed so the handler runs without real I/O.
 */
vi.mock("@/lib/history/storage", () => ({
  loadHistoryEntry: vi.fn(async () => ({
    meta: { sourceType: "upload", sourceFile: "data.csv", question: "q" },
    schema: { filename: "data.csv" },
    generatedCode: "print(1)",
    spec: { root: {} },
    artifacts: {},
    csvContent: "a,b\n1,2",
  })),
  saveHistoryEntry: vi.fn(async () => ({ id: "h-new" })),
}));
vi.mock("@/lib/saved/rehydrate-spec", () => ({ rehydrateSpec: vi.fn(() => ({ root: {} })) }));
vi.mock("@/lib/sandbox", () => ({
  executeSandbox: vi.fn(async () => ({
    success: true,
    results: {},
    chart_data: {},
    datasets: {},
    execution_ms: 5,
  })),
}));
vi.mock("@/lib/sandbox/warm-sandbox", () => ({ ensureWarmSandboxReady: vi.fn(async () => {}) }));
vi.mock("@/lib/runtime-config", () => ({ getActiveSandboxRuntime: vi.fn(() => "docker") }));
vi.mock("@/lib/warehouse/storage", () => ({ getWarehouseConnector: vi.fn() }));
vi.mock("@/lib/csv/parser", () => ({
  parseCSV: vi.fn(() => ({ headers: ["a", "b"], rowCount: 1 })),
  toCSVText: vi.fn(() => "a,b\n1,2"),
}));
vi.mock("@/lib/csv/schema", () => ({ extractSchema: vi.fn(() => ({ filename: "data.csv" })) }));
vi.mock("@/lib/csv/storage", () => ({
  storeCSV: vi.fn(async () => {}),
  storeLocalFileRef: vi.fn(),
}));

import { POST } from "@/app/api/history/[id]/refresh/route";
import { executeSandbox } from "@/lib/sandbox";

beforeEach(() => vi.clearAllMocks());

describe("POST /api/history/[id]/refresh run scope", () => {
  it("passes a real runId to executeSandbox (getRunId resolves inside runWithRunId)", async () => {
    const res = await POST(new Request("http://t/api/history/h1/refresh", { method: "POST" }), {
      params: Promise.resolve({ id: "h1" }),
    });
    expect(res.status).toBe(200);
    expect(executeSandbox).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(executeSandbox).mock.calls[0][2] as { runId?: string };
    expect(opts.runId).toMatch(/^[0-9a-f]{8}$/);
  });
});
