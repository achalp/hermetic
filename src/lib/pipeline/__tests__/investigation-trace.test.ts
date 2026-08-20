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

// ── capDatasets / buildInvestigationTrace / successfulStepNos ──────────────
import {
  capDatasets,
  buildInvestigationTrace,
  successfulStepNos,
} from "@/lib/pipeline/investigation-trace";
import type { SubQuestionResult } from "@/lib/pipeline/investigate-orchestrator";

describe("capDatasets", () => {
  it("returns undefined for an absent datasets map", () => {
    expect(capDatasets(undefined)).toBeUndefined();
  });

  it("caps each dataset to the preview row limit (200) and preserves non-arrays", () => {
    const capped = capDatasets({
      big: Array.from({ length: 500 }, (_, i) => ({ i })),
      small: [{ a: 1 }],
      // A non-array value is passed through untouched.
      weird: "not-an-array" as unknown as Record<string, unknown>[],
    });
    expect(capped!.big).toHaveLength(200);
    expect(capped!.small).toHaveLength(1);
    expect(capped!.weird).toBe("not-an-array");
  });
});

describe("buildInvestigationTrace", () => {
  function sub(over: Partial<SubQuestionResult>): SubQuestionResult {
    return {
      index: 0,
      question: "q",
      rationale: "why",
      depends_on: [],
      ...over,
    } as SubQuestionResult;
  }

  it("maps sub-results to trace steps, classifying every status", () => {
    const trace = buildInvestigationTrace({
      approach: "breadth-first",
      originalQuestion: "the big question",
      sourceByIndex: new Map([[1, "replanner"]]),
      decisions: [],
      subResults: [
        sub({
          index: 0,
          result: {
            generatedCode: "print(1)",
            sql: "SELECT 1",
            stepCsvId: "s0",
            outputCsvId: "o0",
            executionResult: {
              success: true,
              results: { total: 5 },
              chart_data: { bars: [{ x: 1 }] },
              datasets: { main: Array.from({ length: 300 }, (_, i) => ({ i })) },
              execution_ms: 12,
            },
          } as never,
        }),
        sub({ index: 1, error: "NameError" }),
        sub({ index: 2, degraded: true, degradedReason: "all zeros" }),
        sub({ index: 3, removed: true }),
      ],
    });

    expect(trace.approach).toBe("breadth-first");
    expect(trace.originalQuestion).toBe("the big question");
    expect(trace.steps.map((s) => s.status)).toEqual(["success", "failed", "degraded", "removed"]);
    // source defaults to "initial" unless sourceByIndex overrides it.
    expect(trace.steps[0].source).toBe("initial");
    expect(trace.steps[1].source).toBe("replanner");
    // Datasets on the success step are capped to the 200-row preview.
    expect(trace.steps[0].datasets!.main).toHaveLength(200);
    expect(trace.steps[0].code).toBe("print(1)");
    expect(trace.steps[0].stepNo).toBe(1);
    expect(trace.steps[2].degradedReason).toBe("all zeros");
  });
});

describe("successfulStepNos", () => {
  it("returns the 1-based step numbers of success/degraded steps only", () => {
    const trace = buildInvestigationTrace({
      approach: "a",
      originalQuestion: "q",
      sourceByIndex: new Map(),
      decisions: [],
      subResults: [
        {
          index: 0,
          question: "q0",
          rationale: "",
          depends_on: [],
          result: { executionResult: { success: true, results: {}, execution_ms: 1 } },
        } as never,
        { index: 1, question: "q1", rationale: "", depends_on: [], error: "boom" } as never,
        {
          index: 2,
          question: "q2",
          rationale: "",
          depends_on: [],
          degraded: true,
          result: { executionResult: { success: true, results: {}, execution_ms: 1 } },
        } as never,
      ],
    });
    expect(successfulStepNos(trace)).toEqual([1, 3]);
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

  it("accumulates the partial trail mid-run — what a failed run persists (OBS-8)", () => {
    const r = new TraceRecorder();
    r.record({ kind: "sub_started", index: 0, question: "Q0" });
    r.record({
      kind: "sub_finished",
      index: 0,
      stepResult: {
        index: 0,
        question: "Q0",
        rationale: "",
        result: { generatedCode: "print(0)", sql: "SELECT 0" },
      } as never,
    });
    r.record({ kind: "sub_started", index: 1, question: "Q1" });
    r.record({ kind: "sub_failed", index: 1, error: "NameError: x" });
    r.record({ kind: "sub_started", index: 2, question: "Q2" });
    // Run dies here — step 2 still running, nothing returned by the orchestrator.

    const trail = r.partialTrail();
    expect(trail.map((s) => [s.stepNo, s.status])).toEqual([
      [1, "success"],
      [2, "failed"],
      [3, "running"],
    ]);
    expect(trail[0].code).toBe("print(0)");
    expect(trail[0].sql).toBe("SELECT 0");
    expect(trail[1].error).toBe("NameError: x");
    expect(trail[2].question).toBe("Q2");
  });

  it("partial trail: degraded carries its reason; amended steps appear; removed marked", () => {
    const r = new TraceRecorder();
    r.record({ kind: "sub_started", index: 0, question: "Q0" });
    r.record({
      kind: "sub_degraded",
      index: 0,
      degradedReason: "all zeros",
      stepResult: {
        index: 0,
        question: "Q0",
        rationale: "",
        result: { generatedCode: "print(1)" },
      } as never,
    });
    r.record({
      kind: "subs_amended",
      amendmentSource: "replanner",
      addedSteps: [{ index: 2, question: "Q2-added" }],
      removedIndices: [1],
    });

    const trail = r.partialTrail();
    expect(trail.map((s) => [s.index, s.status])).toEqual([
      [0, "degraded"],
      [1, "removed"],
      [2, "pending"],
    ]);
    expect(trail[0].degradedReason).toBe("all zeros");
    expect(trail[2].question).toBe("Q2-added");
  });
});
