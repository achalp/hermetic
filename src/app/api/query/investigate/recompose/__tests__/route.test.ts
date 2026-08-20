import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/query/investigate/recompose — reconstructs an Investigate
 * dashboard from the cached trail via one composer call. This suite covers the
 * pre-flight gates (missing csv_id, no cached trail, expired CSV) and the
 * assembled-success path (composer + spec assembly mocked at the seam).
 */
const getCachedArtifacts = vi.fn();
const getStoredCSV = vi.fn();
const composeInvestigation = vi.fn();
const createSpecFinalizer = vi.fn();
const applySpecPatch = vi.fn();
const parseSpecStreamLine = vi.fn();
vi.mock("@/spec/core", () => ({
  applySpecPatch: (...a: unknown[]) => applySpecPatch(...a),
  parseSpecStreamLine: (...a: unknown[]) => parseSpecStreamLine(...a),
}));
vi.mock("@/lib/pipeline/artifacts-cache", () => ({
  getCachedArtifacts: (...a: unknown[]) => getCachedArtifacts(...a),
}));
vi.mock("@/lib/runtime-config", () => ({ getActiveModels: () => ({ uiCompose: "claude-test" }) }));
vi.mock("@/lib/csv/storage", () => ({ getStoredCSV: (...a: unknown[]) => getStoredCSV(...a) }));
vi.mock("@/lib/llm/investigate-composer", () => ({
  composeInvestigation: (...a: unknown[]) => composeInvestigation(...a),
}));
vi.mock("@/lib/llm/finalize-spec-stream", () => ({
  createSpecFinalizer: (...a: unknown[]) => createSpecFinalizer(...a),
}));
vi.mock("@/lib/cost/epilogue", () => ({
  trackRouteCost: (_m: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { POST } from "@/app/api/query/investigate/recompose/route";

const req = (b: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(b) });
const trace = {
  originalQuestion: "why?",
  approach: "explore",
  steps: [
    {
      index: 0,
      stepNo: 1,
      question: "q1",
      rationale: "r",
      depends_on: [],
      status: "success",
      code: "print(1)",
      results: {},
      chart_data: {},
      datasets: {},
      execution_ms: 1,
    },
  ],
};

function fakeStream(chunks: string[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getCachedArtifacts.mockReturnValue({ investigation: trace });
  getStoredCSV.mockReturnValue({ schema: { columns: [] } });
  createSpecFinalizer.mockReturnValue((line: string) => ({ skip: false, line }));
  parseSpecStreamLine.mockReturnValue({ op: "add" });
});

describe("POST /api/query/investigate/recompose", () => {
  it("400s without a csv_id", async () => {
    expect((await POST(req({}))).status).toBe(400);
  });

  it("404s when no investigation trail is cached", async () => {
    getCachedArtifacts.mockReturnValue({ investigation: undefined });
    expect((await POST(req({ csv_id: "c1" }))).status).toBe(404);
  });

  it("404s when the CSV has expired", async () => {
    getStoredCSV.mockReturnValue(null);
    expect((await POST(req({ csv_id: "c1" }))).status).toBe(404);
  });

  it("502s when the composer produces an empty dashboard", async () => {
    composeInvestigation.mockReturnValue({
      initialState: { results: {}, chart_data: {} },
      textStream: fakeStream([]),
    });
    // No patches applied and root stays empty → 502.
    const res = await POST(req({ csv_id: "c1" }));
    expect(res.status).toBe(502);
  });

  it("assembles and returns the recomposed spec on success", async () => {
    composeInvestigation.mockReturnValue({
      initialState: { results: { a: 1 }, chart_data: {} },
      textStream: fakeStream(['{"op":"add"}\n']),
    });
    // applySpecPatch mutates the spec so root is set and applied > 0.
    applySpecPatch.mockImplementation(
      (spec: { root: string; elements: Record<string, unknown> }) => {
        spec.root = "el0";
        spec.elements.el0 = {};
      }
    );
    const res = await POST(req({ csv_id: "c1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.spec.root).toBe("el0");
  });
});
