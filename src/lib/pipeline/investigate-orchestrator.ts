/**
 * Investigate orchestrator — runs each planned sub-question through the
 * existing single-shot pipeline and collects their results for the
 * composer to synthesize.
 *
 * Concurrency model:
 *
 * - Sub-questions with `depends_on: []` are independent — they all run
 *   in parallel via Promise.all in wave 0.
 * - Sub-questions with `depends_on: [N, M, ...]` wait until every listed
 *   predecessor has completed before starting. Forms a DAG; the wave
 *   grouping below schedules each sub-question into the earliest wave
 *   where all of its predecessors are already done. Each completed
 *   predecessor contributes a ConversationTurn to the dependent's
 *   prior-turn context.
 *
 * Failure handling:
 *
 * - If a sub-question fails after Tier-F retries, we mark it as failed
 *   and continue with the rest. The composer is told which sub-questions
 *   failed so it can synthesize a partial answer.
 * - If MORE THAN HALF of the sub-questions fail, we throw. A degraded
 *   investigation with most pieces missing is worse than a clear error.
 */

import { runPipeline } from "./orchestrator";
import type { PipelineResult } from "./orchestrator";
import type { AdditionalFile } from "@/lib/sandbox";
import type { SandboxRuntimeId } from "@/lib/constants";
import type { CSVSchema, ConversationTurn } from "@/lib/types";
import type { PlannedSubQuestion } from "@/lib/llm/investigate-planner";
import { logger } from "@/lib/logger";

export interface SubQuestionResult {
  index: number;
  question: string;
  rationale: string;
  depends_on: number[];
  /** Set on success. */
  result?: PipelineResult;
  /** Set on failure (after all retries exhausted). */
  error?: string;
  startedAt: number;
  finishedAt: number;
}

export interface InvestigateProgressEvent {
  kind: "plan_ready" | "sub_started" | "sub_finished" | "sub_failed" | "all_done";
  /** Sub-question index (when applicable). */
  index?: number;
  /** Total sub-question count. */
  total?: number;
  /** Sub-question text (for sub_started). */
  question?: string;
  /** Approach text (for plan_ready). */
  approach?: string;
  /** Error message (for sub_failed). */
  error?: string;
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
  /** Reported per-sub-question status updates. */
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

export async function runInvestigation(
  subQuestions: PlannedSubQuestion[],
  options: OrchestrateOptions
): Promise<SubQuestionResult[]> {
  const total = subQuestions.length;
  options.onProgress?.({ kind: "plan_ready", total, approach: "" });

  const waveIndices = groupSubQuestionsIntoWaves(subQuestions);

  // Allocate result slots in original order
  const results: SubQuestionResult[] = subQuestions.map((sq, i) => ({
    index: i,
    question: sq.question,
    rationale: sq.rationale,
    depends_on: sq.depends_on,
    startedAt: 0,
    finishedAt: 0,
  }));

  for (const wave of waveIndices) {
    await Promise.all(
      wave.map(async (i) => {
        const sq = subQuestions[i];
        const slot = results[i];
        slot.startedAt = Date.now();
        options.onProgress?.({
          kind: "sub_started",
          index: i,
          total,
          question: sq.question,
        });

        // Build prior-turn context from upstream completed deps. Each
        // predecessor contributes one ConversationTurn; the code-gen
        // prompt builder already handles arrays of turns natively.
        const priorTurns: ConversationTurn[] = [];
        for (const d of sq.depends_on) {
          const upstream = results[d];
          // A predecessor may have failed; skip it but keep the others
          if (!upstream || !upstream.result) continue;
          const t = turnFromResult(upstream);
          if (t) priorTurns.push(t);
        }

        try {
          const result = await runPipeline(
            options.schema,
            options.csvContent,
            sq.question,
            undefined, // no per-sub onStage; we report at sub-question grain
            "metadata", // schema-only
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
          options.onProgress?.({
            kind: "sub_finished",
            index: i,
            total,
            question: sq.question,
          });
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
      })
    );
  }

  // Half-or-more failures = throw
  const failedCount = results.filter((r) => !r.result).length;
  if (failedCount * 2 >= total) {
    const failures = results
      .filter((r) => r.error)
      .map((r, idx) => `  ${idx + 1}. "${r.question}" — ${(r.error ?? "").slice(0, 200)}`)
      .join("\n");
    throw new Error(
      `Investigation failed: ${failedCount} of ${total} sub-questions failed.\n${failures}`
    );
  }

  options.onProgress?.({ kind: "all_done", total });
  return results;
}
