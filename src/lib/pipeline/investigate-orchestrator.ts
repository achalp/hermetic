/**
 * Investigate orchestrator — runs each planned sub-question through the
 * single-shot pipeline, calls the re-planner between waves to amend or
 * stop the plan based on intermediate findings, and collects the final
 * results for the composer to synthesize.
 *
 * Concurrency model:
 *
 * - Sub-questions with `depends_on: []` are independent — they all run
 *   in parallel via Promise.all in wave 0.
 * - Sub-questions with `depends_on: [N, M, ...]` wait until every listed
 *   predecessor has completed before starting. Forms a DAG; the next
 *   wave is the set of pending sub-questions whose deps are all already
 *   in `completed`. Each completed predecessor contributes a
 *   ConversationTurn to the dependent's prior-turn context.
 *
 * Re-planning loop (the agentic bit):
 *
 * - After each wave finishes (and before the next is dispatched), the
 *   orchestrator calls `generateReplan()` with summaries of every
 *   sub-question completed so far. The re-planner can:
 *     - continue: plan stays unchanged
 *     - amend: append new sub-questions and/or drop pending ones
 *     - stop: skip remaining sub-questions and proceed to composition
 * - Bounded by INVESTIGATE_MAX_HOPS (re-plan calls) and
 *   INVESTIGATE_MAX_SUBQUESTIONS (total sub-questions). Once a cap is
 *   hit the re-planner is no longer consulted.
 *
 * Failure handling:
 *
 * - If a sub-question fails after the per-step retry budget, we mark it
 *   as failed and continue with the rest. The composer is told which
 *   sub-questions failed so it can synthesize a partial answer.
 * - If a sub-question succeeded but `PipelineResult.degraded === true`
 *   (semantic validator exhausted retries), we mark `degraded: true` on
 *   the SubQuestionResult and continue. The re-planner sees it as
 *   "degraded" status; the composer can annotate.
 * - If MORE THAN HALF of the sub-questions fail HARD, we throw.
 *   Degraded sub-questions do NOT count toward the half-failure cap —
 *   they still produced a result.
 */

import { runPipeline } from "./orchestrator";
import type { PipelineResult } from "./orchestrator";
import type { AdditionalFile } from "@/lib/sandbox";
import type { SandboxRuntimeId } from "@/lib/constants";
import {
  INVESTIGATE_MAX_HOPS,
  INVESTIGATE_MAX_SUBQUESTIONS,
  COMPOSER_MAX_DISPATCHES,
  PLANNER_MODEL,
  WAREHOUSE_MAX_ROWS,
} from "@/lib/constants";
import type {
  CSVSchema,
  ConversationTurn,
  WarehouseTableSchema,
  WarehouseType,
  AnalysisWindow,
} from "@/lib/types";
import { generateSQLWithRepair } from "@/lib/warehouse/sql-generation";
import { assessAnswerSufficiency } from "@/lib/llm/answer-sufficiency";
import { parseCSV, toCSVText } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { storeCSV } from "@/lib/csv/storage";
import { buildStepFrames, primaryFrameCsv, type StepFrameSource } from "@/lib/pipeline/step-frames";
import type { AdditionalFile as SandboxFile } from "@/lib/sandbox";
import { randomUUID } from "crypto";

/** Join optional context fragments into one prompt block. */
function joinContext(...parts: (string | undefined)[]): string | undefined {
  const joined = parts.filter((p) => p && p.trim()).join("\n\n");
  return joined || undefined;
}

/**
 * Persist a step's FULL primary output frame in the CSV store and stamp its
 * id on the result. This data is NOT serialized into the trace/history (only
 * the id is), so it doesn't bloat payloads — it just lets a dependent's
 * re-run later consume the complete upstream output instead of the trace's
 * row-capped preview. Best-effort: failure leaves outputCsvId unset and
 * re-run falls back to the preview.
 */
async function persistStepOutput(stepNo: number, result: PipelineResult): Promise<void> {
  try {
    const csv = primaryFrameCsv({
      stepNo,
      datasets: result.executionResult.datasets as
        | Record<string, Record<string, unknown>[]>
        | undefined,
      chart_data: result.executionResult.chart_data as Record<string, unknown> | undefined,
    });
    if (!csv) return;
    const id = randomUUID();
    await storeCSV(id, csv, extractSchema(parseCSV(csv), id, "step_output"));
    result.outputCsvId = id;
  } catch (err) {
    logger.warn("Investigate: failed to persist step output frame", {
      stepNo,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
import {
  generateReplan,
  type InvestigationPlan,
  type PlannedSubQuestion,
  type ReplanDecision,
  type SubQuestionResultSummary,
} from "@/lib/llm/investigate-planner";
import { gapCheckComposer } from "@/lib/llm/investigate-composer";
import { logger } from "@/lib/logger";

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

export interface InvestigateProgressEvent {
  kind:
    | "plan_ready"
    | "sub_started"
    | "sub_finished"
    | "sub_failed"
    | "sub_degraded"
    | "replan_decision"
    | "subs_amended"
    | "composer_dispatched"
    | "all_done";
  /** Sub-question index (when applicable). */
  index?: number;
  /** Total sub-question count (current, post-amendment). */
  total?: number;
  /** Sub-question text (for sub_started). */
  question?: string;
  /** Approach text (for plan_ready). */
  approach?: string;
  /** Error message (for sub_failed). */
  error?: string;
  /** Validator reason (for sub_degraded). */
  degradedReason?: string;
  /** Re-plan action (for replan_decision). */
  replanAction?: "continue" | "amend" | "stop";
  /** Re-plan rationale (for replan_decision). */
  replanRationale?: string;
  /** Newly added sub-questions, in order of insertion (for subs_amended / composer_dispatched). */
  addedSteps?: { index: number; question: string; rationale: string; depends_on: number[] }[];
  /** Indices removed from pending (for subs_amended). */
  removedIndices?: number[];
  /**
   * Who requested the amendment (for subs_amended). Carried on the event so
   * consumers never have to infer provenance from event ordering.
   */
  amendmentSource?: "replanner" | "composer";
  /**
   * The completed sub-question's full result (for sub_finished /
   * sub_degraded). Lets consumers act on the step's artifacts the moment it
   * completes — e.g. dispatching the notebook cell compose — without
   * waiting for the whole investigation to return.
   */
  stepResult?: SubQuestionResult;
  /** Composer's rationale for the dispatch (for composer_dispatched). */
  composerRationale?: string;
}

interface OrchestrateOptions {
  schema: CSVSchema;
  csvContent: string;
  geojsonContent?: string | null;
  additionalFiles?: AdditionalFile[];
  workbookContext?: string;
  localMountPath?: string;
  localFileContext?: string;
  runtime?: SandboxRuntimeId;
  model: string;
  /** The user's original Investigate question (passed to the re-planner). */
  originalQuestion: string;
  /** Planner's high-level approach (passed to the re-planner). */
  approach: string;
  /** Output mode (dashboard/brief/report/deep-dive) — scales each step's
   * analysis volume to the intent via the code-gen prompt. */
  purpose?: string;
  /** Warehouse table schemas, if this Investigate is over a warehouse (passed to the re-planner). */
  warehouse?: WarehouseTableSchema[];
  /**
   * Per-step SQL mode. When set (alongside `warehouse` + `warehouseType`),
   * each sub-question generates and runs its OWN warehouse query, then
   * analyzes that result in Python — instead of every step sharing one
   * up-front materialized CSV. The executor runs a SQL string against the
   * warehouse and resolves with CSV content.
   */
  warehouseExecutor?: (sql: string) => Promise<string>;
  warehouseType?: WarehouseType;
  /**
   * The broad up-front pull's SQL. Given to the sufficiency judge (so it knows
   * what the materialized snapshot contains) and to any escalated per-step SQL
   * (so it reuses the same time window instead of re-scanning the full table).
   */
  materializationSQL?: string;
  /**
   * Host path to the materialized Parquet, copied into the sandbox at
   * /data/input.parquet (via docker cp — no bind-mount). Set for large warehouse
   * pulls; the CSV-first analysis reads it via DuckDB. Mutually exclusive with
   * localMountPath.
   */
  inputParquetPath?: string;
  /** Reported per-sub-question and per-wave status updates. */
  onProgress?: (event: InvestigateProgressEvent) => void;
}

/**
 * Derive the investigation's time window from the materialized data's first
 * date column (its min/max). Robust — reads the already-computed schema
 * metadata rather than parsing SQL. Used to label the dashboard.
 */
export function deriveAnalysisWindow(schema: CSVSchema): AnalysisWindow | undefined {
  for (const col of schema.columns) {
    if (col.meta.kind === "date") {
      return { column: col.name, start: col.meta.min_date, end: col.meta.max_date };
    }
  }
  return undefined;
}

/** A compact description of what the materialized snapshot holds, for the judge. */
function describeMaterializedSnapshot(options: OrchestrateOptions): string {
  const cols = options.schema.columns.map((c) => c.name).join(", ");
  const rows = options.schema.row_count;
  const capped = rows >= WAREHOUSE_MAX_ROWS;
  const parts = [
    `Columns: ${cols}.`,
    `Rows: ${rows.toLocaleString()}${capped ? ` (hit the ${WAREHOUSE_MAX_ROWS.toLocaleString()}-row cap — the source has more, so this is a sample)` : " (the COMPLETE filtered set — not a sample)"}.`,
  ];
  if (options.materializationSQL) {
    parts.unshift(`Pulled by this query:\n${options.materializationSQL}`);
  }
  return parts.join("\n");
}

/** Summarize what a pipeline result computed, for the sufficiency judge. */
function summarizePipelineResult(result: PipelineResult): string {
  const exec = result.executionResult;
  const results = (exec.results ?? {}) as Record<string, unknown>;
  const chart = (exec.chart_data ?? {}) as Record<string, unknown>;
  const chartShapes = Object.entries(chart).map(([k, v]) => {
    const rows = Array.isArray(v) ? v.length : 0;
    const cols =
      Array.isArray(v) && v.length > 0 && typeof v[0] === "object"
        ? Object.keys(v[0] as Record<string, unknown>)
        : [];
    return `${k} (${rows} rows${cols.length ? `, cols: ${cols.join(", ")}` : ""})`;
  });
  const lines = [
    `Result keys: ${Object.keys(results).join(", ") || "(none)"}`,
    `Chart data: ${chartShapes.join("; ") || "(none)"}`,
  ];
  if (result.degraded) {
    lines.push(`NOTE: validator flagged this result degenerate: ${result.degradedReason ?? ""}`);
  }
  return lines.join("\n");
}

/** True when a result is empty/degenerate (no usable output) — auto-insufficient. */
function isDegenerateResult(result: PipelineResult): boolean {
  if (result.degraded) return true;
  const exec = result.executionResult;
  const noResults = Object.keys((exec.results ?? {}) as Record<string, unknown>).length === 0;
  const noCharts = Object.keys((exec.chart_data ?? {}) as Record<string, unknown>).length === 0;
  return noResults && noCharts;
}

/**
 * Analyze the shared materialized CSV in Python for this sub-question. This is
 * the DEFAULT path for warehouse steps: the up-front broad pull usually already
 * holds what a sub-question needs, and analyzing it avoids re-querying the
 * (often enormous) warehouse table.
 */
function runCsvSubQuestion(
  sq: PlannedSubQuestion,
  options: OrchestrateOptions,
  priorTurns: ConversationTurn[],
  depFrames: { files: SandboxFile[]; context: string }
): Promise<PipelineResult> {
  return runPipeline(
    options.schema,
    options.csvContent,
    sq.question,
    undefined,
    "metadata",
    options.model,
    options.runtime,
    options.geojsonContent ?? undefined,
    [...(options.additionalFiles ?? []), ...depFrames.files],
    options.workbookContext,
    options.localMountPath,
    joinContext(options.localFileContext, depFrames.context),
    priorTurns.length > 0 ? priorTurns : undefined,
    options.inputParquetPath,
    options.purpose
  );
}

/**
 * Escalation path: generate a warehouse query scoped to this sub-question —
 * constrained to the SAME time window the up-front materialization used so it
 * doesn't re-scan the full table — execute it (with repair), then run the
 * standard Python pipeline over the result. Throws if SQL gen/exec fails (the
 * caller falls back to the already-computed CSV result).
 */
async function runPerStepSQL(
  sq: PlannedSubQuestion,
  options: OrchestrateOptions,
  priorTurns: ConversationTurn[],
  depFrames: { files: SandboxFile[]; context: string }
): Promise<PipelineResult> {
  const sqlQuestion =
    `Fetch exactly the data needed to answer this analytical question: ${sq.question}\n` +
    `Aggregate/filter/join server-side as appropriate. Return tidy rows ready for charting; LIMIT ${WAREHOUSE_MAX_ROWS}.` +
    (options.materializationSQL
      ? `\n\nIMPORTANT — keep the SAME time window as the dataset already materialized for this investigation; do NOT widen the date range (the source table is enormous and a wider scan is rejected with "rows to read exceeded"). LIMIT does NOT reduce rows scanned — only a bounded WHERE on the date/partition key does. That dataset was pulled with:\n${options.materializationSQL}`
      : "");

  const outcome = await generateSQLWithRepair({
    tables: options.warehouse!,
    question: sqlQuestion,
    warehouseType: options.warehouseType!,
    model: options.model,
    // The window is already bounded, so a timeout/row/memory limit means the
    // query SHAPE is too expensive — repairs would just repeat the multi-minute
    // timeout. Bail fast; the caller keeps the already-computed CSV result.
    bailOnResourceError: true,
    execute: async (candidate) => {
      const csv = await options.warehouseExecutor!(candidate);
      if (!csv || csv.trim() === "") throw new Error("SQL query returned no results");
      return csv;
    },
  });

  // Materialize the step's SQL result as an ephemeral CSV the sandbox can run
  // over (and the notebook can re-run against later).
  const parsed = parseCSV(outcome.result);
  const normalized = toCSVText(parsed);
  const stepCsvId = randomUUID();
  const stepSchema = extractSchema(parsed, stepCsvId, "step_result");
  stepSchema.source_type = "warehouse";
  stepSchema.warehouse_type = options.warehouseType;
  // Inherit the warehouse table's domain rather than re-detecting it from the
  // small aggregated step result. This keeps the code-gen system prompt
  // byte-identical across every sub-question, so they all hit the system-prompt
  // cache warmed before wave-0 (re-detection on a few aggregate columns can
  // otherwise drift to a different domain and miss the cache).
  stepSchema.detected_domain = options.schema.detected_domain;
  await storeCSV(stepCsvId, normalized, stepSchema);

  const result = await runPipeline(
    stepSchema,
    normalized,
    sq.question,
    undefined,
    "metadata",
    options.model,
    options.runtime,
    undefined,
    depFrames.files.length > 0 ? depFrames.files : undefined,
    options.workbookContext,
    undefined,
    joinContext(depFrames.context),
    priorTurns.length > 0 ? priorTurns : undefined,
    undefined,
    options.purpose
  );
  result.sql = outcome.sql;
  result.stepCsvId = stepCsvId;
  return result;
}

/**
 * Warehouse sub-question: analyze the materialized CSV first, conservatively
 * judge whether that answered it, and only escalate to a targeted (window-
 * bounded) per-step warehouse query when the snapshot genuinely lacks what's
 * needed. If the escalation fails, keep the already-computed CSV result.
 */
async function runWarehouseSubQuestion(
  sq: PlannedSubQuestion,
  options: OrchestrateOptions,
  priorTurns: ConversationTurn[],
  depFrames: { files: SandboxFile[]; context: string }
): Promise<PipelineResult> {
  // 1) Analyze the shared materialized snapshot.
  const csvResult = await runCsvSubQuestion(sq, options, priorTurns, depFrames);

  // No warehouse to escalate into → this is all we can do.
  if (!options.warehouseExecutor || !options.warehouse || !options.warehouseType) {
    return csvResult;
  }

  // 2) Conservative sufficiency judgement (a degenerate result skips the call).
  const verdict = isDegenerateResult(csvResult)
    ? { sufficient: false, reason: "CSV analysis produced no usable result" }
    : await assessAnswerSufficiency({
        question: sq.question,
        datasetDescription: describeMaterializedSnapshot(options),
        resultSummary: summarizePipelineResult(csvResult),
        model: PLANNER_MODEL,
      });

  if (verdict.sufficient) {
    logger.info("Investigate: materialized CSV sufficed for sub-question", {
      question: sq.question.slice(0, 120),
      reason: verdict.reason,
    });
    return csvResult;
  }

  // 3) Escalate to a window-bounded per-step query; keep the CSV result if it fails.
  logger.info("Investigate: escalating sub-question to per-step SQL", {
    question: sq.question.slice(0, 120),
    reason: verdict.reason,
  });
  try {
    return await runPerStepSQL(sq, options, priorTurns, depFrames);
  } catch (err) {
    logger.warn("Investigate: per-step SQL failed; keeping materialized-CSV result", {
      question: sq.question.slice(0, 120),
      error: err instanceof Error ? err.message : String(err),
    });
    return csvResult;
  }
}

/** Build a synthetic ConversationTurn from a completed sub-question result. */
function turnFromResult(sub: SubQuestionResult): ConversationTurn | null {
  if (!sub.result) return null;
  const exec = sub.result.executionResult;
  return {
    question: sub.question,
    analysisSummary: {
      resultKeys: Object.fromEntries(Object.entries(exec.results).map(([k, v]) => [k, typeof v])),
      chartDataShapes: Object.fromEntries(
        Object.entries(exec.chart_data).map(([k, v]) => [
          k,
          {
            columns:
              Array.isArray(v) && v.length > 0 && typeof v[0] === "object"
                ? Object.keys(v[0] as Record<string, unknown>)
                : [],
            rows: Array.isArray(v) ? v.length : 0,
          },
        ])
      ),
    },
    specSummary: "",
  };
}

/** Build a re-planner result summary from a completed SubQuestionResult. */
function summaryFromResult(sub: SubQuestionResult): SubQuestionResultSummary {
  const base: SubQuestionResultSummary = {
    index: sub.index,
    question: sub.question,
    rationale: sub.rationale,
    status: sub.error ? "failed" : sub.degraded ? "degraded" : "success",
  };
  if (sub.error) {
    base.errorPreview = sub.error.slice(0, 200);
    return base;
  }
  if (sub.degraded && sub.degradedReason) {
    base.degradedReason = sub.degradedReason;
  }
  if (sub.result) {
    const exec = sub.result.executionResult;
    base.resultKeys = Object.fromEntries(
      Object.entries(exec.results)
        .slice(0, 10)
        .map(([k, v]) => [k, typeof v])
    );
    base.chartDataShapes = Object.fromEntries(
      Object.entries(exec.chart_data)
        .slice(0, 5)
        .map(([k, v]) => [
          k,
          {
            columns:
              Array.isArray(v) && v.length > 0 && typeof v[0] === "object"
                ? Object.keys(v[0] as Record<string, unknown>).slice(0, 8)
                : [],
            rows: Array.isArray(v) ? v.length : 0,
          },
        ])
    );
  }
  return base;
}

/**
 * Group sub-questions into dependency waves for parallel execution.
 *
 * - Wave 0 contains every sub-question with `depends_on: []`.
 * - A sub-question lands in wave `max(wave-of-each-dep) + 1` so that
 *   every predecessor is finished before it starts.
 * - A sub-question whose `depends_on` references an unsatisfiable index
 *   (only possible if the parser missed something, since forward deps
 *   are stripped) is treated as independent and flushed in the next
 *   wave alongside everything else stuck — preventing an infinite loop.
 *
 * Returned waves contain the ORIGINAL sub-question indices (not the
 * sub-question objects), so callers can resolve into their own slot
 * arrays without ambiguity if duplicate sub-question objects ever exist.
 *
 * NOTE: this helper is now used primarily for testing and external
 * inspection. The orchestrator below computes "next wave" dynamically
 * (one wave at a time) because plans can grow between waves via the
 * re-planning loop.
 */
export function groupSubQuestionsIntoWaves(subQuestions: PlannedSubQuestion[]): number[][] {
  const waves: number[][] = [];
  const indexInWave = new Map<number, number>();
  const remaining = subQuestions.map((_, i) => i);
  while (remaining.length > 0) {
    const ready = remaining.filter((i) => {
      const deps = subQuestions[i].depends_on;
      if (!deps || deps.length === 0) return true;
      return deps.every((d) => indexInWave.has(d));
    });
    if (ready.length === 0) {
      logger.warn("Investigate: dependency cycle detected, flushing remaining as parallel");
      ready.push(...remaining);
    }
    const waveNo = waves.length;
    waves.push([...ready]);
    for (const i of ready) indexInWave.set(i, waveNo);
    for (const i of ready) {
      const at = remaining.indexOf(i);
      if (at >= 0) remaining.splice(at, 1);
    }
  }
  return waves;
}

/**
 * Find the next wave of ready sub-questions: pending (not completed,
 * not failed, not removed) whose deps are ALL in `completed`. Returns
 * an empty array when there's nothing ready.
 */
function nextWaveIndices(
  subQuestions: PlannedSubQuestion[],
  completed: Set<number>,
  failed: Set<number>,
  removed: Set<number>
): number[] {
  const ready: number[] = [];
  for (let i = 0; i < subQuestions.length; i++) {
    if (completed.has(i) || failed.has(i) || removed.has(i)) continue;
    const deps = subQuestions[i].depends_on;
    const depsSatisfied = !deps || deps.length === 0 || deps.every((d) => completed.has(d));
    if (depsSatisfied) ready.push(i);
  }
  return ready;
}

/**
 * Test seam: run a single sub-question through the per-step pipeline,
 * record the result (success / degraded / failed), and emit progress.
 */
async function runOneSubQuestion(
  i: number,
  results: SubQuestionResult[],
  subQuestions: PlannedSubQuestion[],
  options: OrchestrateOptions,
  total: number
): Promise<void> {
  const sq = subQuestions[i];
  const slot = results[i];
  slot.startedAt = Date.now();
  options.onProgress?.({
    kind: "sub_started",
    index: i,
    total,
    question: sq.question,
  });

  // Prior-turn context from upstream completed deps. Failed/degraded
  // upstreams: degraded results are still passed in (best-effort), but
  // hard-failed upstreams contribute nothing.
  const priorTurns: ConversationTurn[] = [];
  const depSources: StepFrameSource[] = [];
  for (const d of sq.depends_on) {
    const upstream = results[d];
    if (!upstream || !upstream.result) continue;
    const t = turnFromResult(upstream);
    if (t) priorTurns.push(t);
    // Dataflow: expose this upstream's computed output as a CSV the
    // dependent's Python can load, so steps build on each other instead of
    // each recomputing from the raw source.
    depSources.push({
      stepNo: d + 1,
      datasets: upstream.result.executionResult.datasets as
        | Record<string, Record<string, unknown>[]>
        | undefined,
      chart_data: upstream.result.executionResult.chart_data as Record<string, unknown> | undefined,
    });
  }
  const depFrames = buildStepFrames(depSources);

  try {
    // Per-step SQL when this is a warehouse investigation with an executor
    // wired up; otherwise the standard file-source pipeline.
    const usePerStepSQL =
      !!options.warehouseExecutor && !!options.warehouse && !!options.warehouseType;
    const result = usePerStepSQL
      ? await runWarehouseSubQuestion(sq, options, priorTurns, depFrames)
      : await runPipeline(
          options.schema,
          options.csvContent,
          sq.question,
          undefined,
          "metadata",
          options.model,
          options.runtime,
          options.geojsonContent ?? undefined,
          [...(options.additionalFiles ?? []), ...depFrames.files],
          options.workbookContext,
          options.localMountPath,
          joinContext(options.localFileContext, depFrames.context),
          priorTurns.length > 0 ? priorTurns : undefined,
          options.inputParquetPath,
          options.purpose
        );
    slot.result = result;
    slot.finishedAt = Date.now();
    // Persist the full output so dependents can re-run against it at full
    // fidelity (the trace only keeps a row-capped preview for display).
    await persistStepOutput(i + 1, result);
    if (result.degraded) {
      slot.degraded = true;
      slot.degradedReason = result.degradedReason;
      options.onProgress?.({
        kind: "sub_degraded",
        index: i,
        total,
        question: sq.question,
        degradedReason: result.degradedReason,
        stepResult: slot,
      });
    } else {
      options.onProgress?.({
        kind: "sub_finished",
        index: i,
        total,
        question: sq.question,
        stepResult: slot,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    slot.error = msg;
    slot.finishedAt = Date.now();
    logger.warn("Investigate: sub-question failed", {
      index: i,
      question: sq.question,
      error: msg.slice(0, 300),
    });
    options.onProgress?.({
      kind: "sub_failed",
      index: i,
      total,
      question: sq.question,
      error: msg,
    });
  }
}

/**
 * Apply a re-planner decision: append new sub-questions to the plan and
 * mark pending ones for removal. Returns whether the plan actually
 * changed (any add/remove applied).
 *
 * Defensive guards:
 *
 * - Removal: skip indices already completed, removed, OR failed. The
 *   prompt tells the re-planner to drop only PENDING sub-questions; if
 *   the LLM is sloppy and targets a failed index we'd otherwise hide its
 *   failure annotation from the composer by silently flipping it to
 *   "removed" status.
 *
 * - Addition: drop any new sub-question whose `depends_on` includes an
 *   index in `removed` or `failed`. Such a sub-question can never become
 *   ready (its dep will never enter `completed`), so it would sit forever
 *   as dangling-pending — confusing the composer and the user. The
 *   parser caps depends_on at `[0, selfIdx)` but doesn't know the
 *   runtime state of each index; we do, so we filter here.
 */
function applyAmendment(
  decision: ReplanDecision,
  subQuestions: PlannedSubQuestion[],
  results: SubQuestionResult[],
  completed: Set<number>,
  failed: Set<number>,
  removed: Set<number>,
  options: OrchestrateOptions,
  source: "replanner" | "composer"
): boolean {
  // Drop pending sub-questions the re-planner marked for removal. Skip any
  // index that's already completed, failed, or removed — we don't unwind
  // finished work and we don't silently clobber failures.
  const actuallyRemoved: number[] = [];
  for (const idx of decision.removeSubQuestionIndices) {
    if (idx < 0 || idx >= subQuestions.length) continue;
    if (completed.has(idx) || failed.has(idx) || removed.has(idx)) continue;
    removed.add(idx);
    if (results[idx]) {
      results[idx].removed = true;
    }
    actuallyRemoved.push(idx);
  }

  // Append new sub-questions. Each new one's depends_on may reference any
  // index that exists AFTER this amendment; the parser already restricted
  // depends_on to `< selfIndex` so we don't worry about forward refs here.
  // We DO drop new sub-questions whose deps include any removed or failed
  // index — those would be permanently stuck.
  const addedSteps: NonNullable<InvestigateProgressEvent["addedSteps"]> = [];
  const startIndex = subQuestions.length;
  for (let pos = 0; pos < decision.addSubQuestions.length; pos++) {
    if (subQuestions.length >= INVESTIGATE_MAX_SUBQUESTIONS) {
      logger.warn("Investigate: hit MAX_SUBQUESTIONS cap; ignoring further amendments", {
        cap: INVESTIGATE_MAX_SUBQUESTIONS,
        dropped: decision.addSubQuestions.length - pos,
      });
      break;
    }
    const newSq = decision.addSubQuestions[pos];
    const unsatisfiableDep = newSq.depends_on.find((d) => removed.has(d) || failed.has(d));
    if (unsatisfiableDep !== undefined) {
      logger.warn("Investigate: dropping new sub-question with unsatisfiable dep", {
        question: newSq.question.slice(0, 100),
        depends_on: newSq.depends_on,
        unsatisfiableDep,
        reason: removed.has(unsatisfiableDep) ? "removed" : "failed",
      });
      continue;
    }
    const newIdx = subQuestions.length;
    subQuestions.push(newSq);
    results.push({
      index: newIdx,
      question: newSq.question,
      rationale: newSq.rationale,
      depends_on: newSq.depends_on,
      startedAt: 0,
      finishedAt: 0,
    });
    addedSteps.push({
      index: newIdx,
      question: newSq.question,
      rationale: newSq.rationale,
      depends_on: newSq.depends_on,
    });
  }

  const changed = actuallyRemoved.length > 0 || addedSteps.length > 0;
  if (changed) {
    options.onProgress?.({
      kind: "subs_amended",
      total: subQuestions.length,
      addedSteps,
      removedIndices: actuallyRemoved,
      amendmentSource: source,
    });
    logger.info("Investigate: plan amended", {
      added: addedSteps.length,
      removed: actuallyRemoved.length,
      newTotal: subQuestions.length,
      startIndex,
    });
  }
  return changed;
}

/**
 * Sweep any sub-question that's not in completed/failed/removed into
 * `removed`. This catches "dangling-pending" cases — a sub-question whose
 * dependency chain became unsatisfiable mid-flight (e.g. a pending dep
 * was later removed via the re-planner's remove path). Without this
 * sweep, the composer would see these slots as empty "pending" rows and
 * render confusing empty sections.
 *
 * Returns the indices swept, for logging.
 */
function sweepDanglingPending(
  subQuestions: PlannedSubQuestion[],
  results: SubQuestionResult[],
  completed: Set<number>,
  failed: Set<number>,
  removed: Set<number>
): number[] {
  const swept: number[] = [];
  for (let i = 0; i < subQuestions.length; i++) {
    if (completed.has(i) || failed.has(i) || removed.has(i)) continue;
    removed.add(i);
    if (results[i]) results[i].removed = true;
    swept.push(i);
  }
  if (swept.length > 0) {
    logger.warn("Investigate: sweeping dangling-pending sub-questions", {
      indices: swept,
      total: subQuestions.length,
    });
  }
  return swept;
}

export async function runInvestigation(
  initialSubQuestions: PlannedSubQuestion[],
  options: OrchestrateOptions
): Promise<SubQuestionResult[]> {
  // Mutable copy of the plan — the re-planner can append. Indices stay
  // stable across amendments: removed pending sub-questions are tracked
  // in a Set, not spliced out.
  const subQuestions: PlannedSubQuestion[] = [...initialSubQuestions];
  const results: SubQuestionResult[] = subQuestions.map((sq, i) => ({
    index: i,
    question: sq.question,
    rationale: sq.rationale,
    depends_on: sq.depends_on,
    startedAt: 0,
    finishedAt: 0,
  }));

  const completed = new Set<number>();
  const failed = new Set<number>();
  const removed = new Set<number>();

  options.onProgress?.({
    kind: "plan_ready",
    total: subQuestions.length,
    approach: options.approach,
  });

  let hopCount = 0;
  let waveCount = 0;

  // Dynamic wave loop. Each iteration: pick the next wave of ready
  // sub-questions, run them in parallel, then consult the re-planner
  // (if budget allows) before deciding the next wave.
  // Hard upper bound prevents infinite loops if the re-planner
  // pathologically adds sub-questions that all depend on each other.
  const MAX_WAVES = INVESTIGATE_MAX_SUBQUESTIONS + 2;

  while (waveCount < MAX_WAVES) {
    const wave = nextWaveIndices(subQuestions, completed, failed, removed);
    if (wave.length === 0) break; // nothing pending — investigation done

    waveCount++;
    await Promise.all(
      wave.map((i) => runOneSubQuestion(i, results, subQuestions, options, subQuestions.length))
    );

    // Mark this wave's sub-questions as completed (or failed) based on
    // what runOneSubQuestion recorded. Degraded results count as completed
    // — they produced output, just flagged.
    for (const i of wave) {
      if (results[i].error) {
        failed.add(i);
      } else {
        completed.add(i);
      }
    }

    // Are there pending sub-questions left? If not, no point re-planning.
    const stillPending = subQuestions.some(
      (_, i) => !completed.has(i) && !failed.has(i) && !removed.has(i)
    );

    // Consult the re-planner if there's budget AND there's something left to plan.
    const remainingHops = INVESTIGATE_MAX_HOPS - hopCount;
    if (remainingHops > 0 && stillPending && subQuestions.length < INVESTIGATE_MAX_SUBQUESTIONS) {
      const completedSummaries = Array.from(completed)
        .sort((a, b) => a - b)
        .map((i) => summaryFromResult(results[i]));
      const failedSummaries = Array.from(failed)
        .sort((a, b) => a - b)
        .map((i) => summaryFromResult(results[i]));
      const allSummaries = [...completedSummaries, ...failedSummaries].sort(
        (a, b) => a.index - b.index
      );
      const pendingIndices = subQuestions
        .map((_, i) => i)
        .filter((i) => !completed.has(i) && !failed.has(i) && !removed.has(i));

      const decision = await generateReplan({
        originalQuestion: options.originalQuestion,
        approach: options.approach,
        allSubQuestions: subQuestions,
        completed: allSummaries,
        pendingIndices,
        schema: options.schema,
        warehouse: options.warehouse,
        hopCount,
        remainingHops,
        subQuestionsBudget: INVESTIGATE_MAX_SUBQUESTIONS - subQuestions.length,
        model: PLANNER_MODEL, // re-plan is a cheap structured decision — don't ride the code-gen model
      });
      hopCount++;

      options.onProgress?.({
        kind: "replan_decision",
        total: subQuestions.length,
        replanAction: decision.action,
        replanRationale: decision.rationale,
      });

      if (decision.action === "stop") {
        // Mark all remaining pending as removed and break out
        for (const i of pendingIndices) {
          removed.add(i);
          if (results[i]) results[i].removed = true;
        }
        break;
      }

      if (decision.action === "amend") {
        applyAmendment(
          decision,
          subQuestions,
          results,
          completed,
          failed,
          removed,
          options,
          "replanner"
        );
        // Loop continues; next iteration picks up the new wave including
        // any added sub-questions whose deps are already satisfied.
      }
      // "continue": no change; loop proceeds to next wave naturally.
    }
  }

  // Defense in depth: sweep any sub-question that's still pending after
  // the wave loop terminated. This catches the dangling-pending case where
  // an amend's remove path orphaned a downstream sub-question's dep chain.
  // applyAmendment's defensive drop should prevent this for amend-added
  // sub-questions, but the sweep is cheap and catches anything else.
  sweepDanglingPending(subQuestions, results, completed, failed, removed);

  // ── Composer-dispatched follow-ups (Item #4) ──────────────────────
  // After the wave loop terminates and before composition, give the
  // composer ONE chance to inspect the artifacts and ask for additional
  // sub-questions if the existing results aren't sufficient for a
  // coherent dashboard. Bounded by COMPOSER_MAX_DISPATCHES; the dispatched
  // sub-questions run as one final wave and the orchestrator returns
  // the augmented results.
  if (
    COMPOSER_MAX_DISPATCHES > 0 &&
    subQuestions.length < INVESTIGATE_MAX_SUBQUESTIONS &&
    // Only call gap-check if SOMETHING ran successfully — no point asking
    // about gaps in an empty result set.
    completed.size > 0
  ) {
    // Pass the FULL plan and FULL results to gap-check. Filtering removed
    // entries here would renumber the index space the gap-check parser
    // uses (existingStepCount = subResults.length), which would silently
    // re-map any depends_on the LLM emits. The composer's per-step
    // prompt block already skips removed steps via flattenStepArtifacts,
    // so the LLM sees only valid steps; the parser still caps depends_on
    // at the full plan length so original-index references stay coherent.
    const plan: InvestigationPlan = {
      approach: options.approach,
      subQuestions,
    };
    const gap = await gapCheckComposer({
      originalQuestion: options.originalQuestion,
      plan,
      schema: options.schema,
      subResults: results,
    });

    if (gap.needs.length > 0) {
      // Dispatch as a final amendment. Re-use the existing apply logic
      // with a synthetic ReplanDecision so the cap and bookkeeping work
      // identically.
      const dispatchDecision: ReplanDecision = {
        action: "amend",
        rationale: gap.rationale,
        addSubQuestions: gap.needs,
        removeSubQuestionIndices: [],
      };
      const changed = applyAmendment(
        dispatchDecision,
        subQuestions,
        results,
        completed,
        failed,
        removed,
        options,
        "composer"
      );

      if (changed) {
        options.onProgress?.({
          kind: "composer_dispatched",
          total: subQuestions.length,
          composerRationale: gap.rationale,
        });

        // Run one final wave for the dispatched sub-questions. We bypass
        // the re-planner here on purpose — composer-dispatched follow-ups
        // are a single, terminal extension, not the start of another loop.
        const finalWave = nextWaveIndices(subQuestions, completed, failed, removed);
        if (finalWave.length > 0) {
          await Promise.all(
            finalWave.map((i) =>
              runOneSubQuestion(i, results, subQuestions, options, subQuestions.length)
            )
          );
          for (const i of finalWave) {
            if (results[i].error) failed.add(i);
            else completed.add(i);
          }
        }
        // Sweep again in case a composer-dispatched sub-question still
        // somehow ended up dangling.
        sweepDanglingPending(subQuestions, results, completed, failed, removed);
      }
    }
  }

  // Half-or-more HARD failures = throw. Degraded sub-questions don't
  // count toward this cap — they produced output the composer can
  // still annotate.
  const total = subQuestions.length;
  const failedCount = failed.size;
  if (total > 0 && failedCount * 2 >= total) {
    const failures = Array.from(failed)
      .map((i) => `  - "${results[i].question}" — ${(results[i].error ?? "").slice(0, 200)}`)
      .join("\n");
    throw new Error(
      `Investigation failed: ${failedCount} of ${total} sub-questions failed.\n${failures}`
    );
  }

  options.onProgress?.({ kind: "all_done", total });
  return results;
}
