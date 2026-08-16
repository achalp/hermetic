/**
 * Shared cost/diagnostics epilogue for the query routes.
 *
 * At the end of every run (success, degraded, or error) both Ask and
 * Investigate: read the run's cost accumulator, surface it live to the client
 * as a `/state/__cost` patch, persist a row to data/cost/<date>.csv, and
 * write the run-diagnostics record. This block was duplicated in both routes
 * with drifted semantics (Investigate logged/persisted the per-phase
 * breakdown, Ask didn't; Ask's copy wasn't failure-safe). It lives here now —
 * best-effort by design: a cost-logging failure must never break the stream.
 */
import {
  getCostAccumulator,
  computeCost,
  formatPhaseBreakdown,
  runWithCostTracking,
} from "@/lib/cost/accumulator";
import { getRunId } from "@/lib/run-context";
import { appendCostRow } from "@/lib/cost/storage";
import { writeRunDiagnostics } from "@/lib/diagnostics/run-diagnostics";
import { logger, errMessage } from "@/lib/logger";

export async function emitCostEpilogue(opts: {
  emit: (line: string) => void;
  datasetLabel: string;
  question: string;
  /** Cost-row mode label, e.g. "ask" | "investigate". */
  mode: string;
  purpose?: string;
}): Promise<void> {
  try {
    const acc = getCostAccumulator();
    if (!acc) return;
    const cost = computeCost(acc);
    opts.emit(JSON.stringify({ op: "add", path: "/state/__cost", value: cost }) + "\n");
    const phaseBreakdown = formatPhaseBreakdown(cost.byPhase);
    logger.info("Cost by phase", {
      mode: opts.mode,
      total: Number(cost.costUsd.toFixed(4)),
      output: cost.outputTokens,
      breakdown: phaseBreakdown,
    });
    const now = new Date();
    await appendCostRow({
      timestamp: now.toISOString(),
      date: now.toISOString().slice(0, 10),
      run_id: getRunId(),
      dataset: opts.datasetLabel,
      question: opts.question,
      mode: opts.mode,
      models: cost.models.join(", "),
      llm_calls: cost.llmCalls,
      input_tokens: cost.inputTokens,
      cache_read_tokens: cost.cacheReadTokens,
      cache_write_tokens: cost.cacheWriteTokens,
      output_tokens: cost.outputTokens,
      cost_usd: cost.costUsd,
      duration_ms: cost.wallMs,
      phase_breakdown: phaseBreakdown,
    });
    await writeRunDiagnostics({
      timestamp: now.toISOString(),
      mode: opts.mode,
      purpose: opts.purpose,
      question: opts.question,
      costUsd: cost.costUsd,
      llmCalls: cost.llmCalls,
    });
  } catch (costErr) {
    logger.warn("Cost logging failed", {
      error: errMessage(costErr),
    });
  }
}

/**
 * Cost tracking for the secondary LLM routes (suggest / recompose /
 * rerun-step). These fire real LLM calls — suggest after every analysis —
 * but ran outside any tracking scope, so recordCall() silently no-oped and
 * their spend never reached data/cost/*.csv, undercounting the cost
 * breakdown. Wraps the handler in a tracking scope and appends a row when
 * any LLM call actually happened (an early-return/cache hit writes nothing).
 * Only for handlers that finish their LLM work before returning (all three
 * of these buffer fully); a streaming Response would outlive the scope.
 */
export async function trackRouteCost<T>(
  meta: { mode: string; dataset?: string; question?: string },
  fn: () => Promise<T>
): Promise<T> {
  return runWithCostTracking(async () => {
    try {
      return await fn();
    } finally {
      try {
        const acc = getCostAccumulator();
        const cost = acc ? computeCost(acc) : null;
        if (cost && cost.llmCalls > 0) {
          const now = new Date();
          await appendCostRow({
            timestamp: now.toISOString(),
            date: now.toISOString().slice(0, 10),
            run_id: getRunId(),
            dataset: meta.dataset ?? "-",
            question: meta.question ?? "",
            mode: meta.mode,
            models: cost.models.join(", "),
            llm_calls: cost.llmCalls,
            input_tokens: cost.inputTokens,
            cache_read_tokens: cost.cacheReadTokens,
            cache_write_tokens: cost.cacheWriteTokens,
            output_tokens: cost.outputTokens,
            cost_usd: cost.costUsd,
            duration_ms: cost.wallMs,
            phase_breakdown: formatPhaseBreakdown(cost.byPhase),
          });
        }
      } catch (costErr) {
        logger.warn("Cost logging failed", {
          mode: meta.mode,
          error: errMessage(costErr),
        });
      }
    }
  });
}
