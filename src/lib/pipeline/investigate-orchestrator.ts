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
import { INVESTIGATE_MAX_HOPS, INVESTIGATE_MAX_SUBQUESTIONS } from "@/lib/constants";
import type { CSVSchema, ConversationTurn, WarehouseTableSchema } from "@/lib/types";
import {
  generateReplan,
  type PlannedSubQuestion,
  type ReplanDecision,
  type SubQuestionResultSummary,
} from "@/lib/llm/investigate-planner";
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
  /** Newly added sub-questions, in order of insertion (for subs_amended). */
  addedSteps?: { index: number; question: string; rationale: string; depends_on: number[] }[];
  /** Indices removed from pending (for subs_amended). */
  removedIndices?: number[];
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
  /** Warehouse table schemas, if this Investigate is over a warehouse (passed to the re-planner). */
  warehouse?: WarehouseTableSchema[];
  /** Reported per-sub-question and per-wave status updates. */
  onProgress?: (event: InvestigateProgressEvent) => void;
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
  for (const d of sq.depends_on) {
    const upstream = results[d];
    if (!upstream || !upstream.result) continue;
    const t = turnFromResult(upstream);
    if (t) priorTurns.push(t);
  }

  try {
    const result = await runPipeline(
      options.schema,
      options.csvContent,
      sq.question,
      undefined,
      "metadata",
      options.model,
      options.runtime,
      options.geojsonContent ?? undefined,
      options.additionalFiles,
      options.workbookContext,
      options.localMountPath,
      options.localFileContext,
      priorTurns.length > 0 ? priorTurns : undefined
    );
    slot.result = result;
    slot.finishedAt = Date.now();
    if (result.degraded) {
      slot.degraded = true;
      slot.degradedReason = result.degradedReason;
      options.onProgress?.({
        kind: "sub_degraded",
        index: i,
        total,
        question: sq.question,
        degradedReason: result.degradedReason,
      });
    } else {
      options.onProgress?.({
        kind: "sub_finished",
        index: i,
        total,
        question: sq.question,
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
 */
function applyAmendment(
  decision: ReplanDecision,
  subQuestions: PlannedSubQuestion[],
  results: SubQuestionResult[],
  completed: Set<number>,
  removed: Set<number>,
  options: OrchestrateOptions
): boolean {
  // Drop pending sub-questions the re-planner marked for removal. Already-
  // completed indices in the list are ignored (we never remove finished work).
  const actuallyRemoved: number[] = [];
  for (const idx of decision.removeSubQuestionIndices) {
    if (idx < 0 || idx >= subQuestions.length) continue;
    if (completed.has(idx) || removed.has(idx)) continue;
    removed.add(idx);
    if (results[idx]) {
      results[idx].removed = true;
    }
    actuallyRemoved.push(idx);
  }

  // Append new sub-questions. Each new one's depends_on may reference any
  // index that exists AFTER this amendment, so indices >= subQuestions.length
  // at the time of normalization (i.e. forward references into the SAME
  // amendment batch) are technically allowed by the parser, but the parser
  // already restricted depends_on to < selfIndex at parse time. The result
  // is: a new sub-question added at position N can only depend on indices
  // 0..N-1 (i.e. anything in the plan, completed or not).
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
        model: options.model,
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
        applyAmendment(decision, subQuestions, results, completed, removed, options);
        // Loop continues; next iteration picks up the new wave including
        // any added sub-questions whose deps are already satisfied.
      }
      // "continue": no change; loop proceeds to next wave naturally.
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
