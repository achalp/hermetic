import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the LLM layer: generateText returns the next queued reviewer verdict.
const generateTextMock = vi.fn();
vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));
vi.mock("@/lib/llm/client", () => ({
  getModel: () => ({}),
  cachedSystem: (s: string) => s,
}));

import { reviewGeneratedCode } from "@/lib/pipeline/code-review";

function queue(text: string) {
  generateTextMock.mockReset();
  generateTextMock.mockResolvedValueOnce({ text });
}

describe("reviewGeneratedCode", () => {
  beforeEach(() => generateTextMock.mockReset());

  it("returns severe with ready-to-inject feedback when a severe finding is present", async () => {
    queue(
      JSON.stringify({
        findings: [
          {
            rule: "MEM-KDTREE",
            severity: "severe",
            message: "cKDTree over the raw buildings will OOM; index the cells table instead.",
          },
          { rule: "ENGINE-PANDAS", severity: "minor", message: "filter in DuckDB." },
        ],
      })
    );
    const review = await reviewGeneratedCode("code", "loneliest building in the USA", "3.8 GB");
    expect(review.severity).toBe("severe");
    expect(review.feedback).toContain("MEM-KDTREE");
    // Only severe findings go into the redo feedback.
    expect(review.feedback).not.toContain("ENGINE-PANDAS");
    expect(review.findings).toHaveLength(2);
  });

  it("returns minor (no redo feedback) when only minor findings are present", async () => {
    queue(
      JSON.stringify({ findings: [{ rule: "ENGINE-PANDAS", severity: "minor", message: "x" }] })
    );
    const review = await reviewGeneratedCode("code", "q", "3.8 GB");
    expect(review.severity).toBe("minor");
    expect(review.feedback).toBe("");
  });

  it("returns none for a clean verdict (empty findings)", async () => {
    queue(JSON.stringify({ findings: [] }));
    const review = await reviewGeneratedCode("code", "q", null);
    expect(review.severity).toBe("none");
  });

  it("tolerates JSON wrapped in prose / fencing (extracts the object)", async () => {
    queue('Here is my review:\n```json\n{"findings":[]}\n```\nDone.');
    const review = await reviewGeneratedCode("code", "q", "3.8 GB");
    expect(review.severity).toBe("none");
  });

  it("fails OPEN (severity none) when the reviewer throws — never blocks a run", async () => {
    generateTextMock.mockReset();
    generateTextMock.mockRejectedValueOnce(new Error("model unavailable"));
    const review = await reviewGeneratedCode("code", "q", "3.8 GB");
    expect(review.severity).toBe("none");
    expect(review.findings).toEqual([]);
  });

  it("fails OPEN when the reviewer returns unparseable output", async () => {
    queue("not json at all, no braces");
    const review = await reviewGeneratedCode("code", "q", "3.8 GB");
    expect(review.severity).toBe("none");
  });
});
