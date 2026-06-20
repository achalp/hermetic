import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the composer so the route is importable with no LLM/catalog side effects
// and we control per-step output. vi.hoisted lets the (hoisted) mock factory
// reference the spy safely.
const { composeStepCell } = vi.hoisted(() => ({ composeStepCell: vi.fn() }));
vi.mock("@/lib/llm/step-cell-composer", () => ({ composeStepCell }));
vi.mock("@/lib/logger", () => ({ logger: { warn: () => {}, info: () => {}, error: () => {} } }));

import { POST } from "@/app/api/query/investigate/compose-cell/route";

function post(body: unknown): Request {
  return new Request("http://localhost/api/query/investigate/compose-cell", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  composeStepCell.mockReset();
});

describe("POST /api/query/investigate/compose-cell", () => {
  it("400s on invalid JSON", async () => {
    const res = await POST(post("{not json"));
    expect(res.status).toBe(400);
  });

  it("400s when steps is missing or empty", async () => {
    expect((await POST(post({ approach: "x" }))).status).toBe(400);
    expect((await POST(post({ steps: [] }))).status).toBe(400);
  });

  it("composes each step and returns cells keyed by index", async () => {
    composeStepCell.mockImplementation(async (a: { stepNo: number }) => ({
      root: "c",
      elements: { c: { id: "c", type: "TextBlock", props: { text: `cell ${a.stepNo}` } } },
    }));

    const res = await POST(
      post({
        original_question: "Q",
        approach: "A",
        steps: [
          {
            index: 0,
            stepNo: 1,
            question: "q1",
            rationale: "r1",
            results: { a: 1 },
            chart_data: {},
          },
          {
            index: 2,
            stepNo: 3,
            question: "q3",
            rationale: "r3",
            results: {},
            chart_data: { d: [] },
          },
        ],
      })
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { cells: Record<string, unknown> };
    expect(Object.keys(body.cells).sort()).toEqual(["0", "2"]);
    expect(composeStepCell).toHaveBeenCalledTimes(2);
    // Inputs threaded through correctly.
    expect(composeStepCell).toHaveBeenCalledWith(
      expect.objectContaining({ stepNo: 1, question: "q1", originalQuestion: "Q", approach: "A" })
    );
  });

  it("omits a step whose compose returns null or throws (renders a stub client-side)", async () => {
    composeStepCell.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("boom"));

    const res = await POST(
      post({
        steps: [
          { index: 0, stepNo: 1, question: "q1", rationale: "", results: { a: 1 }, chart_data: {} },
          { index: 1, stepNo: 2, question: "q2", rationale: "", results: { b: 2 }, chart_data: {} },
        ],
      })
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { cells: Record<string, unknown> };
    expect(body.cells).toEqual({});
  });
});
