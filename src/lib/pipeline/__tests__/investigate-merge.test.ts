/**
 * The pure step-merge helpers extracted from runInvestigateQuery — the
 * step_N_ namespacing (formerly inlined 3×) and the dataQuality partitioning.
 * A prefix/off-by-one bug here silently mis-keys the merged roles index, view
 * catalog, and geometry channel; a partition bug drops a failure banner.
 */
import { describe, it, expect } from "vitest";
import {
  mergeStepEntries,
  buildDataQuality,
  type StepResultLike,
  type TraceStepLike,
} from "@/lib/pipeline/investigate-merge";

const step = (
  index: number,
  exec: Record<string, unknown>,
  over: Partial<StepResultLike> = {}
): StepResultLike => ({
  index,
  result: { executionResult: exec },
  ...over,
});

describe("mergeStepEntries — step_<n>_ namespacing", () => {
  it("prefixes each step's keys with step_<index+1>_ (0-based → 1-based)", () => {
    const subs = [step(0, { results: { total: 10 } }), step(1, { results: { total: 20, avg: 5 } })];
    expect(mergeStepEntries(subs, (er) => er.results)).toEqual({
      step_1_total: 10,
      step_2_total: 20,
      step_2_avg: 5,
    });
  });

  it("distinct prefixes keep same-named keys from colliding across steps", () => {
    const subs = [step(0, { chart_data: { grid: "A" } }), step(1, { chart_data: { grid: "B" } })];
    expect(mergeStepEntries(subs, (er) => er.chart_data)).toEqual({
      step_1_grid: "A",
      step_2_grid: "B",
    });
  });

  it("skips removed steps and steps with no result", () => {
    const subs: StepResultLike[] = [
      step(0, { results: { a: 1 } }),
      step(1, { results: { b: 2 } }, { removed: true }),
      { index: 2, result: null },
    ];
    expect(mergeStepEntries(subs, (er) => er.results)).toEqual({ step_1_a: 1 });
  });

  it("a missing sub-map contributes nothing (no undefined keys)", () => {
    const subs = [step(0, { results: { a: 1 } })]; // no regimes
    expect(mergeStepEntries(subs, (er) => er.regimes)).toEqual({});
  });
});

describe("buildDataQuality — partition trace steps for the banner", () => {
  const steps: TraceStepLike[] = [
    { stepNo: 1, question: "q1", status: "success" },
    { stepNo: 2, question: "q2", status: "degraded", degradedReason: "thin data" },
    { stepNo: 3, question: "q3", status: "failed", error: "boom" },
    { stepNo: 4, question: "q4", status: "removed" },
    { stepNo: 5, question: "q5", status: "running" },
  ];

  it("routes each status to its bucket with the right fields", () => {
    const dq = buildDataQuality(steps);
    expect(dq.degraded).toEqual([{ stepNo: 2, question: "q2", reason: "thin data" }]);
    expect(dq.failed).toEqual([{ stepNo: 3, question: "q3", error: "boom" }]);
    expect(dq.removed).toEqual([{ stepNo: 4, question: "q4" }]);
  });

  it("success/running steps appear in no bucket", () => {
    const dq = buildDataQuality(steps);
    const all = [...dq.degraded, ...dq.failed, ...dq.removed].map((s) => s.stepNo);
    expect(all).not.toContain(1);
    expect(all).not.toContain(5);
  });
});
