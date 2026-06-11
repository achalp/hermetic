import { describe, it, expect } from "vitest";
import { transitiveDependents, type TraceStep } from "@/lib/pipeline/investigation-trace";

function step(
  index: number,
  depends_on: number[],
  status: TraceStep["status"] = "success"
): TraceStep {
  return {
    index,
    stepNo: index + 1,
    question: `q${index}`,
    rationale: "",
    status,
    source: "initial",
    depends_on,
  };
}

describe("transitiveDependents", () => {
  // DAG: 0 ← 1 ← 3, 0 ← 2, 4 independent
  const steps = [step(0, []), step(1, [0]), step(2, [0]), step(3, [1]), step(4, [])];

  it("returns direct and transitive dependents in ascending order", () => {
    expect(transitiveDependents(steps, 0)).toEqual([1, 2, 3]);
    expect(transitiveDependents(steps, 1)).toEqual([3]);
  });

  it("returns empty for leaf or independent steps", () => {
    expect(transitiveDependents(steps, 3)).toEqual([]);
    expect(transitiveDependents(steps, 4)).toEqual([]);
  });

  it("skips removed steps", () => {
    const withRemoved = [step(0, []), step(1, [0], "removed"), step(2, [1])];
    // Step 1 is removed; step 2's dep chain passes through it, but a removed
    // step never re-runs, so it is excluded — and 2 still flags via 1's dep.
    expect(transitiveDependents(withRemoved, 0)).toEqual([2]);
  });

  it("does not include the step itself", () => {
    expect(transitiveDependents(steps, 0)).not.toContain(0);
  });
});
