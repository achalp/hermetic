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
    // ALL findings go into the redo feedback now (severity no longer filters) —
    // the writer is asked to fix everything, minor included.
    expect(review.feedback).toContain("MEM-KDTREE");
    expect(review.feedback).toContain("ENGINE-PANDAS");
    expect(review.findings).toHaveLength(2);
  });

  it("still returns feedback for minor-only findings (fix everything)", async () => {
    queue(
      JSON.stringify({ findings: [{ rule: "ENGINE-PANDAS", severity: "minor", message: "x" }] })
    );
    const review = await reviewGeneratedCode("code", "q", "3.8 GB");
    expect(review.severity).toBe("minor");
    // Minor findings now trigger a redo — feedback is non-empty and names the rule.
    expect(review.feedback).toContain("ENGINE-PANDAS");
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

  it("appends skill-contributed extra rules to the critic's RULES list verbatim", async () => {
    queue(JSON.stringify({ findings: [] }));
    await reviewGeneratedCode("code", "q", "3.8 GB", undefined, [
      "COHORT-PIVOT — flag when retention is computed row-wise in Python.",
    ]);
    const call = generateTextMock.mock.calls[0][0] as { system: string };
    expect(call.system).toContain("COHORT-PIVOT — flag when retention is computed row-wise");
    // Inserted inside the RULES section, before the response-format epilogue.
    expect(call.system.indexOf("COHORT-PIVOT")).toBeGreaterThan(
      call.system.indexOf("ENGINE-PANDAS")
    );
    expect(call.system.indexOf("COHORT-PIVOT")).toBeLessThan(
      call.system.indexOf("Respond with ONLY a JSON object")
    );
  });

  it("keeps only domain-agnostic rules in the base prompt — geo rules come from skills", async () => {
    queue(JSON.stringify({ findings: [] }));
    await reviewGeneratedCode("code", "q", "3.8 GB");
    const system = (generateTextMock.mock.calls[0][0] as { system: string }).system;
    expect(system).toContain("MEM-DF —");
    expect(system).toContain("ENGINE-PANDAS —");
    for (const geoRule of [
      "MEM-KDTREE",
      "MEM-RING",
      "MEM-GEOM",
      "GRID-SCALE",
      "POLY-HEAVY",
      "ENGINE-BBOX",
      "HARDCODE-EXTENT",
      "GUARD-NULL",
      "SCAN-OR",
    ]) {
      expect(system).not.toContain(`${geoRule} —`);
    }
  });

  it("emits a byte-stable system prompt when no extra rules are supplied", async () => {
    queue(JSON.stringify({ findings: [] }));
    await reviewGeneratedCode("code", "q", "3.8 GB");
    const without = (generateTextMock.mock.calls[0][0] as { system: string }).system;
    queue(JSON.stringify({ findings: [] }));
    await reviewGeneratedCode("code", "q", "3.8 GB", undefined, []);
    const withEmpty = (generateTextMock.mock.calls[0][0] as { system: string }).system;
    expect(withEmpty).toBe(without);
  });
});
