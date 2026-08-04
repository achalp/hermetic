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

import type { Spec } from "@/spec/core";
import type { SubQuestionResult } from "@/lib/pipeline/investigate-orchestrator";
import type {
  StepStatus,
  StepSource,
  TraceStep,
  TraceDecision,
  PartialTrailStep,
  NotebookLayoutCell,
  NotebookLayout,
  InvestigationTrace,
} from "@/lib/contracts/investigation";
export type {
  StepStatus,
  StepSource,
  TraceStep,
  TraceDecision,
  PartialTrailStep,
  NotebookLayoutCell,
  NotebookLayout,
  InvestigationTrace,
};

import type { GroundingReport } from "@/lib/pipeline/grounding";

/**
 * Accumulates the audit trail's decision log and per-step provenance from the
 * orchestrator's progress events. The events are the only place the
 * re-planner's and composer's rationales surface. This is pure trail logic —
 * it used to live inline in the investigate route's 150-line onProgress
 * switch, which made it untestable except through the HTTP endpoint and
 * pinned the trail format to that one route; the route now keeps only the
 * emit wiring and forwards each event here.
 *
 * Attribution notes (preserved from the inline version): subs_amended events
 * carry their provenance (amendmentSource), so attribution never depends on
 * event ordering. `currentReplan` only tracks the most recent replan decision
 * so a re-planner amendment can fill in its added/removed indices; a composer
 * amendment parks its indices until the matching composer_dispatched event.
 */
export class TraceRecorder {
  readonly decisions: TraceDecision[] = [];
  readonly sourceByIndex = new Map<number, StepSource>();
  private currentReplan: TraceDecision | null = null;
  private pendingComposerAdded: number[] = [];
  private readonly partial = new Map<number, PartialTrailStep>();

  /** Feed one orchestrator progress event. Only trail-relevant kinds matter. */
  record(event: {
    kind: string;
    index?: number;
    question?: string;
    error?: string;
    degradedReason?: string;
    stepResult?: SubQuestionResult;
    replanAction?: "continue" | "amend" | "stop";
    replanRationale?: string;
    composerRationale?: string;
    amendmentSource?: string;
    addedSteps?: { index: number; question?: string }[];
    removedIndices?: number[];
  }): void {
    this.recordPartial(event);
    if (event.kind === "replan_decision") {
      // The matching subs_amended (if the action was "amend") fills in
      // added/removed indices below.
      this.currentReplan = {
        kind: "replan",
        action: event.replanAction,
        rationale: event.replanRationale ?? "",
        addedIndices: [],
        removedIndices: [],
      };
      this.decisions.push(this.currentReplan);
    } else if (event.kind === "subs_amended") {
      const addedIndices = (event.addedSteps ?? []).map((s) => s.index);
      if (event.amendmentSource === "composer") {
        this.pendingComposerAdded = addedIndices;
        for (const idx of addedIndices) this.sourceByIndex.set(idx, "composer");
      } else if (this.currentReplan) {
        this.currentReplan.addedIndices = addedIndices;
        this.currentReplan.removedIndices = event.removedIndices ?? [];
        for (const idx of addedIndices) this.sourceByIndex.set(idx, "replanner");
        this.currentReplan = null;
      }
    } else if (event.kind === "composer_dispatched") {
      // Attribute the steps added by the preceding subs_amended.
      this.decisions.push({
        kind: "composer_dispatch",
        rationale: event.composerRationale ?? "",
        addedIndices: this.pendingComposerAdded,
        removedIndices: [],
      });
      this.pendingComposerAdded = [];
    }
  }

  /** Accumulate the mid-run per-step trail from the same event stream. */
  private recordPartial(event: {
    kind: string;
    index?: number;
    question?: string;
    error?: string;
    degradedReason?: string;
    stepResult?: SubQuestionResult;
    addedSteps?: { index: number; question?: string }[];
    removedIndices?: number[];
  }): void {
    const idx = event.index;
    const ensure = (index: number): PartialTrailStep => {
      let p = this.partial.get(index);
      if (!p) {
        p = { index, stepNo: index + 1, question: "", status: "pending" };
        this.partial.set(index, p);
      }
      return p;
    };

    if (event.kind === "sub_started" && idx !== undefined) {
      const p = ensure(idx);
      if (event.question) p.question = event.question;
      p.status = "running";
    } else if (
      (event.kind === "sub_finished" || event.kind === "sub_degraded") &&
      idx !== undefined
    ) {
      const p = ensure(idx);
      p.status = event.kind === "sub_finished" ? "success" : "degraded";
      if (event.degradedReason) p.degradedReason = event.degradedReason;
      p.code = event.stepResult?.result?.generatedCode;
      p.sql = event.stepResult?.result?.sql;
    } else if (event.kind === "sub_failed" && idx !== undefined) {
      const p = ensure(idx);
      p.status = "failed";
      if (event.error) p.error = event.error;
    } else if (event.kind === "subs_amended") {
      for (const step of event.addedSteps ?? []) {
        const p = ensure(step.index);
        if (step.question) p.question = step.question;
      }
      for (const removed of event.removedIndices ?? []) {
        ensure(removed).status = "removed";
      }
    }
  }

  /**
   * The trail as known right now, in step order — what a failed run persists
   * to diagnostics. Empty until the first sub-question starts.
   */
  partialTrail(): PartialTrailStep[] {
    return [...this.partial.values()].sort((a, b) => a.index - b.index);
  }
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
      outputCsvId: sub.result?.outputCsvId,
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
