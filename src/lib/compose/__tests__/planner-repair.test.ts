/**
 * P13 (quality): the bounded compiled recompose must be INFORMED — the repair
 * advisories have to reach the planner prompt. Before this, they only reached
 * the generative compose prompt, so a compiled repair re-rolled the plan blind
 * and the deterministic realizer reproduced the same defective prose.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();
vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
}));
vi.mock("@/lib/llm/client", () => ({
  getModel: () => ({}),
  cachedSystem: (s: string) => s,
}));

import { generatePlan } from "@/lib/compose/planner";
import type { FindingEntry } from "@/lib/contracts/findings";

const FINDINGS = [
  {
    name: "price_trend",
    dtype: "direction",
    definition: "trend over the period",
    value: { direction: "rising", slope_per_period: 1.2, p_value: 0.01 },
  },
] as FindingEntry[];

beforeEach(() => {
  generateTextMock.mockReset();
  generateTextMock.mockResolvedValue({
    text: JSON.stringify({ nodes: [{ id: "n_a", op: "ANSWER", refs: ["price_trend"] }] }),
  });
});

describe("generatePlan — repair advisories reach the planner prompt", () => {
  it("includes a Repair section listing each advisory on the repair pass", async () => {
    await generatePlan({
      findings: FINDINGS,
      question: "How have prices moved?",
      model: "m",
      repairAdvisories: ["ANSWER node contradicts the trend direction", "dangling clause in n_b"],
    });
    const prompt = (generateTextMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("## Repair");
    expect(prompt).toContain("- ANSWER node contradicts the trend direction");
    expect(prompt).toContain("- dangling clause in n_b");
  });

  it("omits the Repair section entirely on a normal (first) pass", async () => {
    await generatePlan({ findings: FINDINGS, question: "How have prices moved?", model: "m" });
    const prompt = (generateTextMock.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).not.toContain("## Repair");
  });
});
