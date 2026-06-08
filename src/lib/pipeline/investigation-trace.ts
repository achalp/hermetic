/**
 * Investigation audit trail.
 *
 * Hermetic's trust story is "you can see the Python and re-run it." A
 * single-shot Ask exposes exactly one script in the artifacts panel. An
 * Investigate, by contrast, runs many sub-questions, re-plans between waves,
 * and may dispatch composer follow-ups — so a single cached script hides
 * almost all of the reasoning. This module captures the FULL trail: every
 * sub-question's question, code, and result; why the re-planner amended or
 * stopped; and the grounding verdict for the composed narrative.
 *
 * The trace is attached to `CachedArtifacts.investigation` and rendered in the
 * artifacts panel, where each step's code is independently re-runnable through
 * the same edit-and-rerun path single-shot already uses. The agentic loop
 * extends the audit trail rather than outrunning it.
 *
 * The trace carries only schema-level / computed data — the same posture as
 * the rest of Investigate. Code is the LLM-generated Python (no row values);
 * results/chart_data are aggregates the composer already sees.
 */

import type { SubQuestionResult } from "@/lib/pipeline/investigate-orchestrator";
import type { GroundingReport } from "@/lib/pipeline/grounding";

export type StepStatus = "success" | "degraded" | "failed" | "removed";

/** Where a sub-question came from in the agentic loop. */
export type StepSource = "initial" | "replanner" | "composer";

export interface TraceStep {
  /** 0-based index in the (mutable) plan. */
  index: number;
  /** 1-based, matches the composer's `step_N_` namespace and the UI. */
  stepNo: number;
  question: string;
  rationale: string;
  status: StepStatus;
  source: StepSource;
  /** Indices this step depended on (0-based). */
  depends_on: number[];
  /** LLM-generated Python for this step (present for success/degraded). */
  code?: string;
  results?: Record<string, unknown>;
  chart_data?: Record<string, unknown>;
  datasets?: Record<string, Record<string, unknown>[]>;
  execution_ms?: number;
  /** Validator reason when status === "degraded". */
  degradedReason?: string;
  /** Error message when status === "failed". */
  error?: string;
}

export interface TraceDecision {
  kind: "replan" | "composer_dispatch";
  /** Re-planner action; absent for composer dispatches. */
  action?: "continue" | "amend" | "stop";
  rationale: string;
  /** Newly added step indices (0-based) attributable to this decision. */
  addedIndices: number[];
  /** Pending step indices (0-based) dropped by this decision. */
  removedIndices: number[];
}

export interface InvestigationTrace {
  approach: string;
  originalQuestion: string;
  steps: TraceStep[];
  /** Re-planner + composer-dispatch decisions, in the order they were made. */
  decisions: TraceDecision[];
  /** Grounding verdict for the composed narrative (set after composition). */
  grounding?: GroundingReport;
}

function statusOf(sub: SubQuestionResult): StepStatus {
  if (sub.removed) return "removed";
  if (sub.error) return "failed";
  if (sub.degraded) return "degraded";
  return "success";
}

export interface BuildTraceArgs {
  approach: string;
  originalQuestion: string;
  subResults: SubQuestionResult[];
  /** 0-based index → where the step came from. Defaults to "initial". */
  sourceByIndex: Map<number, StepSource>;
  decisions: TraceDecision[];
}

/**
 * Assemble the audit trail from the orchestrator's final sub-results plus the
 * decisions the route accumulated from progress events.
 */
export function buildInvestigationTrace(args: BuildTraceArgs): InvestigationTrace {
  const steps: TraceStep[] = args.subResults.map((sub) => {
    const exec = sub.result?.executionResult;
    return {
      index: sub.index,
      stepNo: sub.index + 1,
      question: sub.question,
      rationale: sub.rationale,
      status: statusOf(sub),
      source: args.sourceByIndex.get(sub.index) ?? "initial",
      depends_on: sub.depends_on ?? [],
      code: sub.result?.generatedCode,
      results: exec?.results as Record<string, unknown> | undefined,
      chart_data: exec?.chart_data as Record<string, unknown> | undefined,
      datasets: exec?.datasets as Record<string, Record<string, unknown>[]> | undefined,
      execution_ms: exec?.execution_ms,
      degradedReason: sub.degradedReason,
      error: sub.error,
    };
  });

  return {
    approach: args.approach,
    originalQuestion: args.originalQuestion,
    steps,
    decisions: args.decisions,
  };
}

/** 1-based step numbers that produced a usable (success/degraded) result. */
export function successfulStepNos(trace: InvestigationTrace): number[] {
  return trace.steps
    .filter((s) => s.status === "success" || s.status === "degraded")
    .map((s) => s.stepNo);
}
