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
});
