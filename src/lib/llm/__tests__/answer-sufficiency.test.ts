import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();
vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));
vi.mock("@/lib/llm/client", () => ({
  getModel: () => ({}),
  cachedSystem: (s: string) => s,
}));

import { assessAnswerSufficiency } from "@/lib/llm/answer-sufficiency";

const ARGS = { question: "q", datasetDescription: "d", resultSummary: "r" };

beforeEach(() => generateTextMock.mockReset());

describe("assessAnswerSufficiency", () => {
  it("parses a sufficient verdict", async () => {
    generateTextMock.mockResolvedValueOnce({ text: '{"sufficient": true, "reason": "all here"}' });
    const v = await assessAnswerSufficiency(ARGS);
    expect(v).toEqual({ sufficient: true, reason: "all here" });
  });

  it("parses an insufficient verdict", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: 'Sure:\n{"sufficient": false, "reason": "needs successes too"}',
    });
    const v = await assessAnswerSufficiency(ARGS);
    expect(v.sufficient).toBe(false);
    expect(v.reason).toBe("needs successes too");
  });

  it("treats a non-boolean / missing sufficient as NOT sufficient (conservative)", async () => {
    generateTextMock.mockResolvedValueOnce({ text: '{"reason": "unclear"}' });
    const v = await assessAnswerSufficiency(ARGS);
    expect(v.sufficient).toBe(false);
  });

  it("returns insufficient on unparseable output", async () => {
    generateTextMock.mockResolvedValueOnce({ text: "I cannot answer." });
    const v = await assessAnswerSufficiency(ARGS);
    expect(v.sufficient).toBe(false);
  });

  it("keeps the CSV result (sufficient) when the judge call throws", async () => {
    generateTextMock.mockRejectedValueOnce(new Error("no credits"));
    const v = await assessAnswerSufficiency(ARGS);
    expect(v.sufficient).toBe(true);
    expect(v.reason).toBe("assessment unavailable");
  });
});
