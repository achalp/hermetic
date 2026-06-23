import { describe, it, expect } from "vitest";
import { parsePlannerOutput } from "@/lib/llm/investigate-planner";

function planJson(n: number): string {
  const subs = Array.from({ length: n }, (_, i) => ({
    question: `Sub-question number ${i} about the data`,
    rationale: "because",
    depends_on: [],
  }));
  return JSON.stringify({ approach: "approach", subQuestions: subs });
}

describe("parsePlannerOutput — purpose-scoped cap", () => {
  it("caps the plan to the passed maxSubQuestions (e.g. dashboard=3)", () => {
    const r = parsePlannerOutput(planJson(6), 3);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.subQuestions).toHaveLength(3);
  });

  it("defaults the cap to 7 when not specified (back-compat)", () => {
    const r = parsePlannerOutput(planJson(10));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.subQuestions).toHaveLength(7);
  });

  it("does not pad up — keeps fewer than the cap when the model emits fewer", () => {
    const r = parsePlannerOutput(planJson(2), 3);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.subQuestions).toHaveLength(2);
  });

  it("still rejects an under-2 plan regardless of cap", () => {
    const r = parsePlannerOutput(planJson(1), 4);
    expect(r.ok).toBe(false);
  });
});
