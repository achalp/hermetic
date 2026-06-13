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
 * The trace carries computed data only — the same posture as the rest of
 * Investigate. Code is the LLM-generated Python; results/chart_data are
 * aggregates the composer already sees; per-step datasets are capped to a
 * small preview (TRACE_DATASET_MAX_ROWS) so the serialized trace stays small.
 */

import type { Spec } from "@json-render/core";
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
  /**
   * Per-step SQL (warehouse investigations): the query this step ran to
   * fetch its data. Shown as a SQL cell/disclosure in the notebook.
   */
  sql?: string;
  /**
   * csv_id of this step's SQL result, so the step's Python re-runs against
   * the same data (notebook re-run for per-step-SQL warehouse steps).
   */
  stepCsvId?: string;
  /**
   * Notebook-mode cell: a small composed spec visualizing this step's
   * result (placeholders already resolved). Set after the per-step cell
   * compose finishes; absent for failed/removed steps or when the cell
   * compose failed (notebook renders a stub instead).
   */
  cellSpec?: Spec;
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

/**
 * Per-step datasets are capped to a preview: steps can emit up to 5000 rows
 * each, and the trace is serialized whole into the artifacts response and
 * every history entry — an 8-step investigation would otherwise ship tens of
 * MB. 200 rows is plenty for the Trail's audit view; re-running the step
 * recomputes the full data.
 */
const TRACE_DATASET_MAX_ROWS = 200;

export function capDatasets(
  datasets: Record<string, Record<string, unknown>[]> | undefined
): Record<string, Record<string, unknown>[]> | undefined {
  if (!datasets) return undefined;
  const capped: Record<string, Record<string, unknown>[]> = {};
  for (const [name, rows] of Object.entries(datasets)) {
    capped[name] = Array.isArray(rows) ? rows.slice(0, TRACE_DATASET_MAX_ROWS) : rows;
  }
  return capped;
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
      sql: sub.result?.sql,
      stepCsvId: sub.result?.stepCsvId,
      results: exec?.results as Record<string, unknown> | undefined,
      chart_data: exec?.chart_data as Record<string, unknown> | undefined,
      datasets: capDatasets(
        exec?.datasets as Record<string, Record<string, unknown>[]> | undefined
      ),
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

/**
 * 0-based indices of every step that transitively depends on `index` via
 * `depends_on`, in ascending order. The planner restricts `depends_on` to
 * indices below the step's own, so ascending index order is a valid
 * topological order for re-running them.
 *
 * Used by notebook mode's DAG-aware re-run: when a step's code is edited
 * and re-run, its transitive dependents are flagged stale.
 */
export function transitiveDependents(steps: TraceStep[], index: number): number[] {
  const affected = new Set<number>([index]);
  // Single ascending pass suffices because deps always point backwards.
  // Removed steps PROPAGATE staleness (a dependent of a removed step still
  // transitively rests on the changed step) but are excluded from the
  // result — a dropped step never re-runs.
  const ordered = [...steps].sort((a, b) => a.index - b.index);
  for (const step of ordered) {
    if (step.depends_on.some((d) => affected.has(d))) {
      affected.add(step.index);
    }
  }
  affected.delete(index);
  const removed = new Set(steps.filter((s) => s.status === "removed").map((s) => s.index));
  return [...affected].filter((i) => !removed.has(i)).sort((a, b) => a - b);
}

/** 1-based step numbers that produced a usable (success/degraded) result. */
export function successfulStepNos(trace: InvestigationTrace): number[] {
  return trace.steps
    .filter((s) => s.status === "success" || s.status === "degraded")
    .map((s) => s.stepNo);
}
