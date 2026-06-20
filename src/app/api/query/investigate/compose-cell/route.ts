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

  return Response.json({ cells });
}
