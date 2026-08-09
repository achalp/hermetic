/**
 * Investigation & artifacts contracts: the audit-trail shapes shared by the
 * orchestrator (producer), persistence (history/saved records), and the UI
 * (notebook, artifacts panel). Extracted from pipeline/investigation-trace,
 * pipeline/artifacts-cache, and llm/investigate-planner — modularization
 * M1-1e: client code imports types from here, never from server modules.
 */

import type { Spec } from "@/lib/contracts/spec";
import type { FilterValue } from "@/lib/contracts/spec-types";
import type { GroundingReport } from "./grounding";
import type { PipelineResult } from "./pipeline";

/**
 * One sub-question's outcome in an Investigate run. Moved here from
 * pipeline/investigate-orchestrator (its producer) so llm/investigate-composer
 * (its consumer) imports a contract, not the pipeline layer above it.
 */
export interface SubQuestionResult {
  index: number;
  question: string;
  rationale: string;
  depends_on: number[];
  /** Set on success. */
  result?: PipelineResult;
  /** True when the pipeline returned a result but the semantic validator flagged it (exhausted retries on degenerate output). */
  degraded?: boolean;
  /** When `degraded` is true, the validator's reason — useful for re-planner and composer. */
  degradedReason?: string;
  /** Set on hard failure (execution failed after all retries). */
  error?: string;
  /** True when the re-planner asked to drop this pending sub-question. */
  removed?: boolean;
  startedAt: number;
  finishedAt: number;
}

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
   * csv_id of this step's FULL primary output frame (uncapped). The trace's
   * own `datasets` are a display-preview (TRACE_DATASET_MAX_ROWS); this id
   * points at the complete output in the server CSV store so a dependent's
   * re-run flows full-fidelity upstream data. Points at expired data after
   * the store's TTL — re-run then falls back to the preview.
   */
  outputCsvId?: string;
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

/**
 * A step's outcome as known MID-RUN, from progress events alone. The full
 * TraceStep is only assembled from the orchestrator's return value — which a
 * mid-run failure never produces. This is what a failed run can still persist
 * (OBS-8): status, error, and the generated code/SQL of every step that got
 * far enough to have them.
 */
export interface PartialTrailStep {
  index: number;
  stepNo: number;
  question: string;
  status: "pending" | "running" | "success" | "degraded" | "failed" | "removed";
  error?: string;
  degradedReason?: string;
  code?: string;
  sql?: string;
}

/**
 * A user-authored notebook layout overlaid on the step trail: lets the user
 * insert markdown cells and reorder cells. Absent → the notebook renders the
 * steps in their natural order. Persists with the trace (and thus history).
 */
export type NotebookLayoutCell =
  | { kind: "step"; stepNo: number }
  | { kind: "markdown"; id: string; content: string };

export interface NotebookLayout {
  cells: NotebookLayoutCell[];
}

export interface InvestigationTrace {
  approach: string;
  originalQuestion: string;
  steps: TraceStep[];
  /** Re-planner + composer-dispatch decisions, in the order they were made. */
  decisions: TraceDecision[];
  /** Grounding verdict for the composed narrative (set after composition). */
  grounding?: GroundingReport;
  /** User-authored notebook layout (markdown cells + ordering). */
  notebook?: NotebookLayout;
}

export interface CachedArtifacts {
  code: string;
  question: string;
  results: Record<string, unknown>;
  chart_data: Record<string, unknown>;
  datasets: Record<string, Record<string, unknown>[]>;
  execution_ms: number;
  /** SQL query generated for warehouse data sources */
  sql?: string;
  /** Validated declared-findings manifest (spec §1); absent pre-findings
   *  and when findings.mode=off. */
  findings?: import("./findings").FindingsManifest;
  /** Narrative plan document (narrative-compiler spec) — present when the
   *  dashboard was compiled; the mutation API edits and recompiles it. */
  plan?: import("./plan").PlanDocument;
  /** Validated declared series with roles (analysis-product spec §1) —
   *  kept for inspectability (Verify/exports); chart_data holds the
   *  synthesized view of the same rows. Absent for legacy envelopes. */
  series?: import("./product").SeriesEntry[];
  /** Envelope regime profiles by series id (regime-matrix spec) — the
   *  edit-path recompile derives the same evidence views live compose did.
   *  Absent for legacy envelopes. */
  regimes?: Record<string, unknown>;
  /**
   * Full audit trail for an Investigate run: every sub-question's code +
   * result, the re-planner's decisions, and the narrative grounding verdict.
   * Absent for single-shot Ask. When present, the artifacts panel renders a
   * per-step, re-runnable trail in addition to the top-level code/data tabs.
   */
  investigation?: InvestigationTrace;
}

export interface InvestigateScope {
  /** The question the parent investigation answered. */
  parent_question?: string;
  /** The parent investigation's approach (from its plan). */
  prior_approach?: string;
  /** Sub-questions the parent already explored (so we don't repeat them). */
  prior_steps?: string[];
  /** Segment filters to restrict every sub-question to (from a chart drill). */
  filters?: { column: string; value: FilterValue }[];
  /** Human-readable label for the drilled segment. */
  segment_label?: string;
}
