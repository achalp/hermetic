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

// ── TraceRecorder — decision/provenance accumulation from progress events ──
import { TraceRecorder } from "@/lib/pipeline/investigation-trace";

describe("TraceRecorder", () => {
  it("fills a replan decision's added/removed from the matching subs_amended", () => {
    const r = new TraceRecorder();
    r.record({ kind: "replan_decision", replanAction: "amend", replanRationale: "need depth" });
    r.record({
      kind: "subs_amended",
      amendmentSource: "replanner",
      addedSteps: [{ index: 3 }, { index: 4 }],
      removedIndices: [2],
    });
    expect(r.decisions).toEqual([
      {
        kind: "replan",
        action: "amend",
        rationale: "need depth",
        addedIndices: [3, 4],
        removedIndices: [2],
      },
    ]);
    expect(r.sourceByIndex.get(3)).toBe("replanner");
    expect(r.sourceByIndex.get(4)).toBe("replanner");
  });

  it("parks composer-added steps until the composer_dispatched event", () => {
    const r = new TraceRecorder();
    r.record({ kind: "subs_amended", amendmentSource: "composer", addedSteps: [{ index: 5 }] });
    expect(r.sourceByIndex.get(5)).toBe("composer");
    expect(r.decisions).toHaveLength(0); // not attributed yet
    r.record({ kind: "composer_dispatched", composerRationale: "gap: seasonality" });
    expect(r.decisions).toEqual([
      {
        kind: "composer_dispatch",
        rationale: "gap: seasonality",
        addedIndices: [5],
        removedIndices: [],
      },
    ]);
  });

  it("a composer amendment does not consume a pending replan decision", () => {
    const r = new TraceRecorder();
    r.record({ kind: "replan_decision", replanAction: "amend", replanRationale: "r" });
    // Composer amendment arrives before the replanner's own subs_amended.
    r.record({ kind: "subs_amended", amendmentSource: "composer", addedSteps: [{ index: 9 }] });
    r.record({ kind: "subs_amended", amendmentSource: "replanner", addedSteps: [{ index: 6 }] });
    expect(r.decisions[0].addedIndices).toEqual([6]); // replan got its own steps
    expect(r.sourceByIndex.get(9)).toBe("composer");
    expect(r.sourceByIndex.get(6)).toBe("replanner");
  });

  it("ignores unrelated event kinds", () => {
    const r = new TraceRecorder();
    r.record({ kind: "sub_started" });
    r.record({ kind: "sub_finished" });
    expect(r.decisions).toHaveLength(0);
    expect(r.sourceByIndex.size).toBe(0);
  });
});
