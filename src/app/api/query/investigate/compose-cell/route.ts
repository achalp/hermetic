/**
 * Lazy notebook-cell composition. When an Investigate run is submitted from the
 * Dashboard view, the route skips eager per-step cell composes (a cost
 * optimization). If the user later opens the Notebook view, the client posts the
 * (already-streamed) per-step trace data here and we compose the missing cells
 * on demand — the same `composeStepCell` the streaming route uses, just deferred
 * so we don't pay for cells nobody looks at.
 *
 * Schema-only privacy is preserved: the inputs are the aggregated per-step
 * results/chart_data the client already holds, not raw rows.
 */
import { composeStepCell } from "@/lib/llm/step-cell-composer";
import { isValidModelId, type ModelId } from "@/lib/constants";
import { runWithCostTracking, getCostAccumulator, computeCost } from "@/lib/cost/accumulator";
import { appendCostRow } from "@/lib/cost/storage";
import { logger } from "@/lib/logger";

interface CellRequestStep {
  index: number;
  stepNo: number;
  question: string;
  rationale: string;
  results?: Record<string, unknown>;
  chart_data?: Record<string, unknown>;
  degraded?: boolean;
  degradedReason?: string;
}

interface ComposeCellBody {
  original_question?: string;
  approach?: string;
  ui_compose_model?: string;
  steps?: CellRequestStep[];
}

export async function POST(request: Request): Promise<Response> {
  let body: ComposeCellBody;
  try {
    body = (await request.json()) as ComposeCellBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const steps = body.steps;
  if (!Array.isArray(steps) || steps.length === 0) {
    return Response.json({ error: "steps is required" }, { status: 400 });
  }

  const uiComposeModel: ModelId | undefined =
    body.ui_compose_model && isValidModelId(body.ui_compose_model)
      ? (body.ui_compose_model as ModelId)
      : undefined;

  const originalQuestion = body.original_question ?? "";
  const approach = body.approach ?? "";

  // Compose all requested cells in parallel; a failed one is simply omitted
  // (the client renders a stub, exactly as the streaming path does).
  return runWithCostTracking(async () => {
    const composed = await Promise.all(
      steps.map(async (s) => {
        try {
          const spec = await composeStepCell({
            stepNo: s.stepNo,
            question: s.question,
            rationale: s.rationale,
            originalQuestion,
            approach,
            results: s.results ?? {},
            chartData: s.chart_data ?? {},
            degraded: s.degraded,
            degradedReason: s.degradedReason,
            uiComposeModel,
          });
          return spec ? ([s.index, spec] as const) : null;
        } catch (err) {
          logger.warn("Lazy cell compose failed", {
            index: s.index,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      })
    );

    const cells: Record<number, unknown> = {};
    for (const entry of composed) {
      if (entry) cells[entry[0]] = entry[1];
    }

    // Persist the deferred cell-compose cost (best-effort; no live footer here).
    try {
      const acc = getCostAccumulator();
      if (acc) {
        const cost = computeCost(acc);
        const now = new Date();
        await appendCostRow({
          timestamp: now.toISOString(),
          date: now.toISOString().slice(0, 10),
          dataset: "(notebook cells)",
          question: originalQuestion || "(notebook cells)",
          mode: "notebook-cells",
          models: cost.models.join(", "),
          llm_calls: cost.llmCalls,
          input_tokens: cost.inputTokens,
          cache_read_tokens: cost.cacheReadTokens,
          cache_write_tokens: cost.cacheWriteTokens,
          output_tokens: cost.outputTokens,
          cost_usd: cost.costUsd,
        });
      }
    } catch (costErr) {
      logger.warn("Cost logging failed (cells)", {
        error: costErr instanceof Error ? costErr.message : String(costErr),
      });
    }

    return Response.json({ cells });
  });
}
