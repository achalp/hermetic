import { describe, it, expect } from "vitest";
import { buildRunDiagnostics, type DiagEvent } from "@/lib/diagnostics/run-diagnostics";

const META = { timestamp: "2026-06-23T06:31:09.000Z", mode: "investigate", purpose: "dashboard" };

describe("buildRunDiagnostics", () => {
  it("captures the materialization record", () => {
    const events: DiagEvent[] = [
      { type: "materialization", rows: 1_000_000, sampled: true, parquet: true, sqlRepairs: 1 },
    ];
    const rec = buildRunDiagnostics(events, META);
    expect(rec.materialization).toEqual({
      table: undefined,
      rows: 1_000_000,
      sampled: true,
      parquet: true,
      sqlRepairs: 1,
      aborted: undefined,
    });
    expect(rec.date).toBe("2026-06-23");
  });

  it("groups escalation + retries + status per sub-question, in order", () => {
    const events: DiagEvent[] = [
      { type: "escalation", step: "Q1", reason: "snapshot is a sample" },
      { type: "step_done", step: "Q1", status: "ok" },
      { type: "retry", step: "Q2", errorClass: "semantic_all_zeros", kind: "semantic" },
      { type: "step_done", step: "Q2", status: "degraded", statusReason: "all zeros" },
    ];
    const rec = buildRunDiagnostics(events, META);
    expect(rec.steps.map((s) => s.step)).toEqual(["Q1", "Q2"]); // first-seen order

    const q1 = rec.steps[0];
    expect(q1.escalated).toBe(true);
    expect(q1.escalationReason).toBe("snapshot is a sample");
    expect(q1.path).toBe("escalated");
    expect(q1.status).toBe("ok");

    const q2 = rec.steps[1];
    expect(q2.escalated).toBe(false);
    expect(q2.retries).toBe(1);
    expect(q2.retryClasses).toEqual(["semantic_all_zeros"]);
    expect(q2.status).toBe("degraded");
  });

  it("summarizes the cost-driving signals (escalation/degraded/retry classes)", () => {
    // Mirrors the real $1.04 run: every step escalated.
    const events: DiagEvent[] = [];
    for (const q of ["Q1", "Q2", "Q3", "Q4", "Q5"]) {
      events.push({ type: "escalation", step: q, reason: "biased sample" });
      events.push({ type: "step_done", step: q, status: "ok" });
    }
    events.push({ type: "retry", step: "Q4", errorClass: "py_other", kind: "execution" });
    events.push({ type: "retry", step: "Q5", errorClass: "semantic_all_zeros", kind: "semantic" });

    const rec = buildRunDiagnostics(events, { ...META, costUsd: 1.04, llmCalls: 32 });
    expect(rec.summary.subQuestions).toBe(5);
    expect(rec.summary.escalated).toBe(5); // the invisible cost driver, now visible
    expect(rec.summary.totalRetries).toBe(2);
    expect(rec.summary.retryClassCounts).toEqual({ py_other: 1, semantic_all_zeros: 1 });
    expect(rec.costUsd).toBe(1.04);
  });

  it("ignores events without a step key (run-level noise)", () => {
    const rec = buildRunDiagnostics(
      [{ type: "retry", errorClass: "py_x", kind: "execution" }],
      META
    );
    expect(rec.steps).toHaveLength(0);
    expect(rec.summary.totalRetries).toBe(0);
  });

  it("persists stage transitions — numeric step means the step-grouping can't carry them", () => {
    // Regression (OBS-9 follow-through): emitProgress emits {stage, step: number,
    // total}; the string-keyed grouping silently dropped these from the record.
    const rec = buildRunDiagnostics(
      [
        { type: "stage", stage: "planning", step: 1, total: 5 },
        { type: "stage", stage: "investigating", step: 2, total: 5 },
      ],
      META
    );
    expect(rec.stages).toEqual([
      { stage: "planning", step: 1, total: 5 },
      { stage: "investigating", step: 2, total: 5 },
    ]);
    expect(rec.steps).toHaveLength(0); // not misfiled as sub-question steps
  });

  it("persists failure evidence verbatim (sandbox_failure, investigation_failed)", () => {
    // OBS-8/OBS-10: these run-scoped events have no step key and were dropped —
    // exactly the runs that most need a post-mortem trail left none.
    const failedTrail = {
      type: "investigation_failed",
      error: "compose blew up",
      partialSteps: [{ stepNo: 1, question: "Q0", status: "success", code: "print(0)" }],
      decisions: [],
    };
    const rec = buildRunDiagnostics(
      [
        { type: "sandbox_failure", runtime: "docker", exitCode: 137, stderrHead: "Killed" },
        failedTrail,
      ],
      META
    );
    expect(rec.failures).toHaveLength(2);
    expect(rec.failures![0]).toMatchObject({ type: "sandbox_failure", exitCode: 137 });
    expect(rec.failures![1]).toMatchObject(failedTrail);
  });

  it("omits stages/failures keys entirely on a clean run", () => {
    const rec = buildRunDiagnostics([{ type: "step_done", step: "Q1", status: "ok" }], META);
    expect(rec.stages).toBeUndefined();
    expect(rec.failures).toBeUndefined();
  });
});
