import { describe, it, expect, vi, beforeEach } from "vitest";
import { groupSubQuestionsIntoWaves } from "@/lib/pipeline/investigate-orchestrator";
import type { PlannedSubQuestion } from "@/lib/llm/investigate-planner";

// ── Mocks for the agentic-loop tests below ─────────────────────────
// runPipeline does sandbox execution + LLM calls; generateReplan does
// an LLM call. We stub both to return deterministic results.

vi.mock("@/lib/pipeline/orchestrator", () => ({
  runPipeline: vi.fn(),
}));
vi.mock("@/lib/llm/investigate-planner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm/investigate-planner")>();
  return {
    ...actual,
    generateReplan: vi.fn(),
  };
});
vi.mock("@/lib/llm/investigate-composer", () => ({
  gapCheckComposer: vi.fn(),
}));

import { runInvestigation } from "@/lib/pipeline/investigate-orchestrator";
import { runPipeline } from "@/lib/pipeline/orchestrator";
import { generateReplan } from "@/lib/llm/investigate-planner";
import { gapCheckComposer } from "@/lib/llm/investigate-composer";
import type { CSVSchema } from "@/lib/types";

const mockedRunPipeline = vi.mocked(runPipeline);
const mockedGenerateReplan = vi.mocked(generateReplan);
const mockedGapCheck = vi.mocked(gapCheckComposer);

function freshSchema(): CSVSchema {
  return {
    filename: "test.csv",
    csv_id: "test",
    row_count: 100,
    column_count: 1,
    columns: [],
    detected_domain: undefined,
    correlations: [],
  } as unknown as CSVSchema;
}

function pipelineOk(question: string) {
  return Promise.resolve({
    executionResult: {
      success: true as const,
      results: { value: 1 },
      chart_data: {},
      images: {},
      execution_ms: 10,
    },
    generatedCode: "ok",
    question,
  });
}

function pipelineDegraded(question: string) {
  return Promise.resolve({
    executionResult: {
      success: true as const,
      results: {},
      chart_data: {},
      images: {},
      execution_ms: 10,
    },
    generatedCode: "ok",
    question,
    degraded: true,
    degradedReason: "Empty result",
  });
}

function pipelineFail(question: string) {
  return Promise.reject(new Error(`hard failure for ${question}`));
}

beforeEach(() => {
  mockedRunPipeline.mockReset();
  mockedGenerateReplan.mockReset();
  mockedGapCheck.mockReset();
  // Default re-planner behavior: always continue
  mockedGenerateReplan.mockResolvedValue({
    action: "continue",
    rationale: "no change",
    addSubQuestions: [],
    removeSubQuestionIndices: [],
  });
  // Default gap-check behavior: no needs (compose immediately)
  mockedGapCheck.mockResolvedValue({ needs: [], rationale: "sufficient" });
});

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

describe("runInvestigation — agentic loop", () => {
  it("runs all sub-questions when re-planner continues every time", async () => {
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineOk(q));

    const results = await runInvestigation([sq("A", []), sq("B", []), sq("C", [0, 1])], {
      schema: freshSchema(),
      csvContent: "",
      model: "test-model",
      originalQuestion: "test",
      approach: "test approach",
    });

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.result && !r.error && !r.degraded)).toBe(true);
    expect(mockedRunPipeline).toHaveBeenCalledTimes(3);
  });

  it("invokes the re-planner once per wave when there's pending work", async () => {
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineOk(q));
    // 3 sub-questions in 3 waves (linear) → 2 between-wave re-plan calls.
    await runInvestigation([sq("A", []), sq("B", [0]), sq("C", [1])], {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
    });
    // After wave 1 (A done, B+C pending) → call re-planner.
    // After wave 2 (B done, C pending) → call re-planner.
    // After wave 3 (C done, none pending) → no call.
    expect(mockedGenerateReplan).toHaveBeenCalledTimes(2);
  });

  it("skips re-planner when no pending sub-questions remain", async () => {
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineOk(q));
    // All independent → one wave, then nothing pending.
    await runInvestigation([sq("A", []), sq("B", [])], {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
    });
    expect(mockedGenerateReplan).not.toHaveBeenCalled();
  });

  it("appends a new sub-question on amend and runs it in a subsequent wave", async () => {
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineOk(q));

    let replanCallCount = 0;
    mockedGenerateReplan.mockImplementation(async () => {
      replanCallCount++;
      if (replanCallCount === 1) {
        return {
          action: "amend",
          rationale: "Drill into top region",
          addSubQuestions: [
            { question: "Drill into top finding", rationale: "r", depends_on: [0] },
          ],
          removeSubQuestionIndices: [],
        };
      }
      return {
        action: "continue",
        rationale: "",
        addSubQuestions: [],
        removeSubQuestionIndices: [],
      };
    });

    // Wave 0: A. After wave 0 (B is pending), re-planner runs and amends.
    // Wave 1: B and the new sub-question C (both depend on 0, which is done).
    const results = await runInvestigation([sq("A", []), sq("B", [0])], {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
    });

    // Original 2 + 1 added = 3 total sub-questions
    expect(results).toHaveLength(3);
    expect(results[2].question).toBe("Drill into top finding");
    expect(results[2].depends_on).toEqual([0]);
    expect(results[2].result).toBeTruthy(); // it ran
  });

  it("stops early when re-planner returns stop", async () => {
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineOk(q));
    mockedGenerateReplan.mockResolvedValueOnce({
      action: "stop",
      rationale: "nothing interesting in wave 0",
      addSubQuestions: [],
      removeSubQuestionIndices: [],
    });

    // Wave 0: A independent. Pending: B (depends on 0), C (depends on 0).
    const results = await runInvestigation([sq("A", []), sq("B", [0]), sq("C", [0])], {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
    });

    // A ran; B and C were dropped as removed
    expect(results[0].result).toBeTruthy();
    expect(results[1].removed).toBe(true);
    expect(results[2].removed).toBe(true);
    expect(mockedRunPipeline).toHaveBeenCalledTimes(1);
  });

  it("removes pending sub-questions via removeSubQuestionIndices", async () => {
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineOk(q));
    mockedGenerateReplan.mockResolvedValueOnce({
      action: "amend",
      rationale: "drop one pending",
      addSubQuestions: [],
      removeSubQuestionIndices: [1], // drop B which is pending (depends_on: [0])
    });

    const results = await runInvestigation([sq("A", []), sq("B", [0]), sq("C", [0])], {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
    });

    expect(results[0].result).toBeTruthy();
    expect(results[1].removed).toBe(true);
    expect(results[2].result).toBeTruthy(); // C still ran
  });

  it("ignores remove indices that point at already-completed sub-questions", async () => {
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineOk(q));
    mockedGenerateReplan.mockResolvedValueOnce({
      action: "amend",
      rationale: "try to remove the already-finished one",
      addSubQuestions: [],
      removeSubQuestionIndices: [0], // A is already completed
    });

    const results = await runInvestigation([sq("A", []), sq("B", [0])], {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
    });

    // A was NOT removed (already done); B still ran
    expect(results[0].removed).toBeUndefined();
    expect(results[0].result).toBeTruthy();
    expect(results[1].result).toBeTruthy();
  });

  it("propagates degraded flag from PipelineResult to SubQuestionResult", async () => {
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineDegraded(q));

    const results = await runInvestigation([sq("A", []), sq("B", [])], {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
    });

    expect(results[0].degraded).toBe(true);
    expect(results[0].degradedReason).toBe("Empty result");
    expect(results[0].error).toBeUndefined();
  });

  it("emits sub_degraded progress event when a sub-question is degraded", async () => {
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineDegraded(q));
    const events: string[] = [];

    await runInvestigation([sq("A", []), sq("B", [])], {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
      onProgress: (e) => events.push(e.kind),
    });

    expect(events).toContain("sub_degraded");
    expect(events).not.toContain("sub_failed");
  });

  it("emits replan_decision progress event after each between-wave re-plan", async () => {
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineOk(q));
    mockedGenerateReplan.mockResolvedValue({
      action: "continue",
      rationale: "ok",
      addSubQuestions: [],
      removeSubQuestionIndices: [],
    });

    const events: { kind: string; action?: string }[] = [];
    await runInvestigation([sq("A", []), sq("B", [0]), sq("C", [1])], {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
      onProgress: (e) => events.push({ kind: e.kind, action: e.replanAction }),
    });

    const replanEvents = events.filter((e) => e.kind === "replan_decision");
    expect(replanEvents.length).toBe(2); // 3 waves → 2 between-wave calls
    for (const r of replanEvents) expect(r.action).toBe("continue");
  });

  it("emits subs_amended event with added/removed details", async () => {
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineOk(q));
    mockedGenerateReplan.mockResolvedValueOnce({
      action: "amend",
      rationale: "amend",
      addSubQuestions: [{ question: "New sub-question", rationale: "r", depends_on: [0] }],
      removeSubQuestionIndices: [1],
    });

    const amendEvents: {
      added?: number;
      removed?: number[];
      total?: number;
    }[] = [];
    await runInvestigation([sq("A", []), sq("B", [0])], {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
      onProgress: (e) => {
        if (e.kind === "subs_amended") {
          amendEvents.push({
            added: e.addedSteps?.length,
            removed: e.removedIndices,
            total: e.total,
          });
        }
      },
    });

    expect(amendEvents).toHaveLength(1);
    expect(amendEvents[0].added).toBe(1);
    expect(amendEvents[0].removed).toEqual([1]);
    expect(amendEvents[0].total).toBe(3);
  });

  it("enforces INVESTIGATE_MAX_SUBQUESTIONS cap on amendments", async () => {
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineOk(q));
    // Repeatedly amend with one new sub-question; the cap should stop adds.
    mockedGenerateReplan.mockImplementation(async () => ({
      action: "amend",
      rationale: "more!",
      addSubQuestions: [{ question: "Yet another sub-question", rationale: "r", depends_on: [] }],
      removeSubQuestionIndices: [],
    }));

    const results = await runInvestigation([sq("A", []), sq("B", [])], {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
    });

    // Cap is INVESTIGATE_MAX_SUBQUESTIONS = 10 — final length cannot exceed it
    expect(results.length).toBeLessThanOrEqual(10);
  });

  it("does not consult re-planner past INVESTIGATE_MAX_HOPS", async () => {
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineOk(q));
    // Linear chain of 5 → 4 between-wave opportunities, but cap is 2 hops.
    await runInvestigation([sq("A", []), sq("B", [0]), sq("C", [1]), sq("D", [2]), sq("E", [3])], {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
    });
    expect(mockedGenerateReplan).toHaveBeenCalledTimes(2);
  });

  it("does not count degraded sub-questions toward the half-failure throw", async () => {
    // 2 degraded out of 4 — should NOT throw. (Hard-fail threshold is half.)
    let n = 0;
    mockedRunPipeline.mockImplementation((_s, _c, q) => {
      n++;
      return n <= 2 ? pipelineDegraded(q) : pipelineOk(q);
    });

    await expect(
      runInvestigation([sq("A", []), sq("B", []), sq("C", []), sq("D", [])], {
        schema: freshSchema(),
        csvContent: "",
        model: "m",
        originalQuestion: "test",
        approach: "a",
      })
    ).resolves.toBeDefined();
  });

  it("throws when half or more sub-questions HARD-fail", async () => {
    let n = 0;
    mockedRunPipeline.mockImplementation((_s, _c, q) => {
      n++;
      return n <= 2 ? pipelineFail(q) : pipelineOk(q);
    });

    await expect(
      runInvestigation([sq("A", []), sq("B", []), sq("C", []), sq("D", [])], {
        schema: freshSchema(),
        csvContent: "",
        model: "m",
        originalQuestion: "test",
        approach: "a",
      })
    ).rejects.toThrow(/Investigation failed/);
  });
});

describe("runInvestigation — composer-dispatched follow-ups (item #4)", () => {
  it("calls gap-check after the main loop terminates", async () => {
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineOk(q));
    await runInvestigation([sq("A", []), sq("B", [])], {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
    });
    expect(mockedGapCheck).toHaveBeenCalledTimes(1);
  });

  it("skips gap-check when no sub-questions completed successfully", async () => {
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineFail(q));
    await expect(
      runInvestigation([sq("A", [])], {
        schema: freshSchema(),
        csvContent: "",
        model: "m",
        originalQuestion: "test",
        approach: "a",
      })
    ).rejects.toThrow();
    expect(mockedGapCheck).not.toHaveBeenCalled();
  });

  it("dispatches and runs follow-up sub-questions when gap-check requests them", async () => {
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineOk(q));
    mockedGapCheck.mockResolvedValueOnce({
      needs: [{ question: "Compute denominator", rationale: "needed for rate", depends_on: [] }],
      rationale: "Missing total population for the rate calc.",
    });

    const results = await runInvestigation([sq("A", []), sq("B", [])], {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
    });

    // 2 original + 1 dispatched = 3 total
    expect(results).toHaveLength(3);
    expect(results[2].question).toBe("Compute denominator");
    expect(results[2].result).toBeTruthy(); // it ran
    expect(mockedRunPipeline).toHaveBeenCalledTimes(3);
  });

  it("emits composer_dispatched progress event with rationale", async () => {
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineOk(q));
    mockedGapCheck.mockResolvedValueOnce({
      needs: [{ question: "Need one more thing", rationale: "gap", depends_on: [] }],
      rationale: "Missing a denominator.",
    });

    const events: { kind: string; composerRationale?: string }[] = [];
    await runInvestigation([sq("A", []), sq("B", [])], {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
      onProgress: (e) => events.push({ kind: e.kind, composerRationale: e.composerRationale }),
    });

    const dispatched = events.find((e) => e.kind === "composer_dispatched");
    expect(dispatched).toBeDefined();
    expect(dispatched?.composerRationale).toBe("Missing a denominator.");
  });

  it("does NOT re-call gap-check after the dispatched wave (one-shot)", async () => {
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineOk(q));
    mockedGapCheck.mockResolvedValue({
      needs: [{ question: "Another follow-up please", rationale: "g", depends_on: [] }],
      rationale: "still need more",
    });

    await runInvestigation([sq("A", [])], {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
    });

    // Even though gap-check keeps requesting needs, we only call it once.
    expect(mockedGapCheck).toHaveBeenCalledTimes(1);
  });

  it("respects INVESTIGATE_MAX_SUBQUESTIONS when applying composer dispatch", async () => {
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineOk(q));
    // Pre-fill the plan to 10 sub-questions (the cap)
    const subs = Array.from({ length: 10 }, (_, i) => sq(`Q${i}`, []));
    mockedGapCheck.mockResolvedValueOnce({
      needs: [{ question: "Try to push us past the cap", rationale: "g", depends_on: [] }],
      rationale: "more",
    });

    const results = await runInvestigation(subs, {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
    });

    // Should still be 10 — gap-check's request was capped out
    expect(results).toHaveLength(10);
  });

  it("propagates degraded flag through the dispatched sub-question too", async () => {
    let n = 0;
    mockedRunPipeline.mockImplementation((_s, _c, q) => {
      n++;
      // First 2 are normal; dispatched (3rd) is degraded.
      return n <= 2 ? pipelineOk(q) : pipelineDegraded(q);
    });
    mockedGapCheck.mockResolvedValueOnce({
      needs: [{ question: "Dispatched follow-up", rationale: "g", depends_on: [] }],
      rationale: "need it",
    });

    const results = await runInvestigation([sq("A", []), sq("B", [])], {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
    });

    expect(results).toHaveLength(3);
    expect(results[2].degraded).toBe(true);
  });
});

describe("runInvestigation — defensive guards (review fixes)", () => {
  it("drops new sub-questions whose depends_on references a failed index", async () => {
    mockedRunPipeline.mockImplementation((_s, _c, q) =>
      q.startsWith("B-fails") ? pipelineFail(q) : pipelineOk(q)
    );

    mockedGenerateReplan.mockResolvedValueOnce({
      action: "amend",
      rationale: "drill into the failed step",
      // depends_on: [1] is failed → must be dropped to prevent dangling
      addSubQuestions: [
        { question: "Drill into failed branch", rationale: "broken", depends_on: [1] },
      ],
      removeSubQuestionIndices: [],
    });

    const results = await runInvestigation([sq("A", []), sq("B-fails", []), sq("C", [0])], {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
    });

    // Plan should still be the original 3; the bad add was dropped.
    expect(results).toHaveLength(3);
    expect(results.some((r) => r.question === "Drill into failed branch")).toBe(false);
  });

  it("drops new sub-questions whose depends_on references a removed index", async () => {
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineOk(q));
    mockedGenerateReplan.mockResolvedValueOnce({
      action: "amend",
      rationale: "drop B, add C that depends on B (which we just removed)",
      addSubQuestions: [{ question: "Build on removed B", rationale: "broken", depends_on: [1] }],
      removeSubQuestionIndices: [1], // B is pending, gets removed
    });

    const results = await runInvestigation([sq("A", []), sq("B", [0])], {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
    });

    // A ran. B was removed by the same amendment. The new sub-question
    // depended on B (now removed) so it should be dropped, not added.
    expect(results[0].result).toBeTruthy();
    expect(results[1].removed).toBe(true);
    expect(results.some((r) => r.question === "Build on removed B")).toBe(false);
  });

  it("does NOT remove a sub-question that's already in the failed set", async () => {
    // Re-planner sloppily asks to remove index 1, which is in `failed`.
    // The defensive guard should leave it alone so its failure annotation
    // survives into the composer.
    mockedRunPipeline.mockImplementation((_s, _c, q) =>
      q.startsWith("B-fails") ? pipelineFail(q) : pipelineOk(q)
    );
    mockedGenerateReplan.mockResolvedValueOnce({
      action: "amend",
      rationale: "try to remove the failed one",
      addSubQuestions: [],
      removeSubQuestionIndices: [1], // index 1 hard-failed
    });

    const results = await runInvestigation([sq("A", []), sq("B-fails", []), sq("C", [0])], {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
    });

    // index 1's failure is preserved; it must NOT be marked removed.
    expect(results[1].error).toBeTruthy();
    expect(results[1].removed).toBeUndefined();
  });

  it("sweeps dangling-pending sub-questions into removed after the loop", async () => {
    // Construct a plan where the re-planner removes a pending dep,
    // leaving a downstream sub-question with an unsatisfiable dep that
    // applyAmendment can't defend against (because the downstream was
    // in the ORIGINAL plan, not an added one). The sweep should catch it.
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineOk(q));

    let n = 0;
    mockedGenerateReplan.mockImplementation(async () => {
      n++;
      if (n === 1) {
        // After wave 0 (A done), drop the pending B. C still pending,
        // but C depends on B → C is now dangling.
        return {
          action: "amend",
          rationale: "drop B",
          addSubQuestions: [],
          removeSubQuestionIndices: [1],
        };
      }
      return {
        action: "continue",
        rationale: "",
        addSubQuestions: [],
        removeSubQuestionIndices: [],
      };
    });

    const results = await runInvestigation(
      [sq("A", []), sq("B", [0]), sq("C", [1])], // C depends on B
      {
        schema: freshSchema(),
        csvContent: "",
        model: "m",
        originalQuestion: "test",
        approach: "a",
      }
    );

    // A ran, B was removed by re-planner, C should be swept as removed
    // (its only dep was B, now removed). C must NOT remain dangling.
    expect(results[0].result).toBeTruthy();
    expect(results[1].removed).toBe(true);
    expect(results[2].removed).toBe(true);
    expect(results[2].result).toBeUndefined();
    expect(results[2].error).toBeUndefined();
  });

  it("passes the FULL results array (including removed) to gap-check", async () => {
    // After a stop wipes some pending sub-questions, gap-check must see
    // the full plan so its depends_on numbering matches the orchestrator.
    mockedRunPipeline.mockImplementation((_s, _c, q) => pipelineOk(q));
    mockedGenerateReplan.mockResolvedValueOnce({
      action: "stop",
      rationale: "no further drill needed",
      addSubQuestions: [],
      removeSubQuestionIndices: [],
    });

    let observedSubResultsLength = 0;
    mockedGapCheck.mockImplementationOnce(async (args) => {
      observedSubResultsLength = args.subResults.length;
      return { needs: [], rationale: "no gap" };
    });

    await runInvestigation([sq("A", []), sq("B", [0]), sq("C", [0])], {
      schema: freshSchema(),
      csvContent: "",
      model: "m",
      originalQuestion: "test",
      approach: "a",
    });

    // After stop, B and C are removed. Gap-check must still see all 3
    // result slots so its depends_on numbering is anchored to the full
    // plan, not a filtered subset.
    expect(observedSubResultsLength).toBe(3);
  });
});
