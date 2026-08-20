import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/suggest — starter/follow-up question generation. The LLM call
 * (generateText) is mocked; the route's job under test is input validation
 * and the line-splitting/filtering of the model's text into a questions[].
 */
const generateText = vi.fn();
vi.mock("ai", () => ({ generateText: (...a: unknown[]) => generateText(...a) }));
vi.mock("@/lib/llm/client", () => ({ getModel: () => ({}), cachedSystem: (s: string) => s }));
vi.mock("@/lib/constants", () => ({ SUGGEST_MODEL: "claude-haiku-test" }));
vi.mock("@/lib/cost/epilogue", () => ({
  trackRouteCost: (_meta: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { POST } from "@/app/api/suggest/route";

const req = (b: unknown) =>
  new Request("http://x/api/suggest", { method: "POST", body: JSON.stringify(b) });
const schema = { row_count: 10, columns: [{ name: "region", dtype: "str" }] };

beforeEach(() => vi.clearAllMocks());

describe("POST /api/suggest", () => {
  it("400s when neither schema nor warehouseSchema is provided", async () => {
    const res = await POST(req({ mode: "schema" }));
    expect(res.status).toBe(400);
  });

  it("returns up to 5 schema-mode questions parsed from the model text", async () => {
    generateText.mockResolvedValue({
      text: "What drives regional sales?\nWhich month peaked?\nx\nHow do segments compare?",
    });
    const res = await POST(req({ mode: "schema", schema }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // "x" is dropped (too short); the three real questions survive.
    expect(body.questions).toEqual([
      "What drives regional sales?",
      "Which month peaked?",
      "How do segments compare?",
    ]);
  });

  it("400s a follow-up request that omits the prior question", async () => {
    const res = await POST(req({ mode: "follow-up", schema }));
    expect(res.status).toBe(400);
  });

  it("returns follow-up questions, stripping list markers and preamble", async () => {
    generateText.mockResolvedValue({
      text: "Here are three follow-up questions:\n1. Why did the north region grow fastest?\n2. Which segment declined year-over-year?\n- How did pricing shift across quarters?",
    });
    const res = await POST(req({ mode: "follow-up", schema, question: "sales by region?" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.questions).toContain("Why did the north region grow fastest?");
    expect(body.questions).not.toContain("Here are three follow-up questions:");
  });
});
