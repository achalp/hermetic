import { describe, it, expect } from "vitest";
import { groupSubQuestionsIntoWaves } from "@/lib/pipeline/investigate-orchestrator";
import type { PlannedSubQuestion } from "@/lib/llm/investigate-planner";

function sq(question: string, depends_on: number[]): PlannedSubQuestion {
  return { question, rationale: "", depends_on };
}

describe("groupSubQuestionsIntoWaves", () => {
  it("puts every independent sub-question in wave 0", () => {
    const subs = [sq("A", []), sq("B", []), sq("C", [])];
    expect(groupSubQuestionsIntoWaves(subs)).toEqual([[0, 1, 2]]);
  });

  it("schedules a linear chain across consecutive waves", () => {
    const subs = [sq("A", []), sq("B", [0]), sq("C", [1])];
    expect(groupSubQuestionsIntoWaves(subs)).toEqual([[0], [1], [2]]);
  });

  it("schedules a multi-dep sub-question after the latest of its deps", () => {
    // 0, 1 independent; 2 depends on both 0 and 1
    const subs = [sq("Top region", []), sq("Bottom region", []), sq("Compare", [0, 1])];
    expect(groupSubQuestionsIntoWaves(subs)).toEqual([[0, 1], [2]]);
  });

  it("schedules diamond-shaped DAGs correctly", () => {
    // 0 -> 1, 0 -> 2, (1,2) -> 3
    const subs = [sq("root", []), sq("left", [0]), sq("right", [0]), sq("join", [1, 2])];
    expect(groupSubQuestionsIntoWaves(subs)).toEqual([[0], [1, 2], [3]]);
  });

  it("schedules a sub-question after the LATER of two priors in different waves", () => {
    // 0 indep; 1 depends on 0; 2 depends on 0 and 1 → must be in wave 2
    const subs = [sq("a", []), sq("b", [0]), sq("c", [0, 1])];
    expect(groupSubQuestionsIntoWaves(subs)).toEqual([[0], [1], [2]]);
  });

  it("preserves original indices in wave membership (not sub-question objects)", () => {
    const dup = sq("same text", []);
    const subs = [dup, dup, sq("third", [0])];
    const waves = groupSubQuestionsIntoWaves(subs);
    // Both copies must land in wave 0 by their distinct indices
    expect(waves[0]).toEqual([0, 1]);
    expect(waves[1]).toEqual([2]);
  });

  it("treats empty / undefined depends_on as independent", () => {
    const subs: PlannedSubQuestion[] = [
      { question: "a", rationale: "", depends_on: [] },
      // Simulate a slot that lost its array somehow — defensive guard
      { question: "b", rationale: "", depends_on: undefined as unknown as number[] },
    ];
    expect(groupSubQuestionsIntoWaves(subs)).toEqual([[0, 1]]);
  });

  it("recovers from a dependency cycle by flushing remaining as parallel", () => {
    // 0 depends on 1, 1 depends on 0 — impossible. The grouper should
    // not infinite-loop; it should flush remaining into a wave with a
    // warning.
    const subs = [sq("A", [1]), sq("B", [0])];
    const waves = groupSubQuestionsIntoWaves(subs);
    expect(waves).toEqual([[0, 1]]);
  });

  it("handles an empty plan", () => {
    expect(groupSubQuestionsIntoWaves([])).toEqual([]);
  });
});
