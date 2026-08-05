/**
 * Investigate endpoint — runs a multi-step deep analysis.
 *
 * Thin transport shell (modularization M3-3b): parse + validate the request
 * and provider capability, then hand the PatchStream to runInvestigateQuery —
 * the investigation itself lives in lib/pipeline/run-investigate-query.ts,
 * callable by any harness.
 *
 * Privacy: same schema-only model as Ask. Each sub-question's LLM call
 * sees only the schema + statistics, never row values. The composer sees
 * aggregated RESULTS (scalars, chart data shapes), never raw rows.
 */

import { apiError, validationErrorResponse } from "@/app/lib/api-error";
import { patchStreamResponse } from "@/lib/pipeline/patch-stream";
import { persistHistoryOnDisconnect } from "@/lib/history/persist-on-disconnect";
import { validateQueryIds, resolveQuerySources } from "@/lib/pipeline/validate-request";
import { readJsonBody, parseBody, analysisRequestSchema } from "@/lib/api-schemas";
import { getActiveProvider, providerCapabilities } from "@/lib/llm/client";
import {
  runInvestigateQuery,
  type InvestigateRunState,
} from "@/lib/pipeline/run-investigate-query";

export const maxDuration = 1260; // 21 min — investigations over large/remote datasets can run long

export async function POST(request: Request) {
  // Aborted duplicate requests truncate the body — a 400, not a logged 500.
  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  try {
    const parsed = parseBody(analysisRequestSchema, read.body);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const context = body.context ?? {};

    // ── Shared preamble step 1: ids/question 400s (lib/pipeline/
    // validate-request.ts — same module Ask uses, so the two routes can't
    // drift again). The provider gate below sits between the syntactic 400s
    // and the resource 404s, preserving the route's check order. ──
    const ids = validateQueryIds(context, body.prompt);
    if (!ids.ok) return validationErrorResponse(ids);
    const { warehouseId, question } = ids;

    // Investigate is a heavyweight cloud-LLM operation. Local backends are
    // gated at the UI level; refuse here as a safety net.
    let activeProvider: ReturnType<typeof getActiveProvider>;
    try {
      activeProvider = getActiveProvider();
    } catch (err) {
      return apiError("/api/query/investigate", err, "No LLM configured", 400);
    }
    // Capability lives in ONE place (providerCapabilities) — this route's
    // hand-maintained refusal list had drifted from Ask's validation list.
    if (!providerCapabilities(activeProvider).supportsInvestigate) {
      return new Response(
        JSON.stringify({
          error:
            "Investigate mode requires a cloud LLM provider (Anthropic, Bedrock, Vertex, or OpenAI-compatible). Local models plan and synthesize multi-step investigations poorly. Switch in Settings or use Ask instead.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── Shared preamble step 2: warehouse/CSV 404s + model/runtime
    // resolution. Investigate skips the warehouse lookup when a csv_id
    // exists (follow-up over an already-materialized pull) and 404s a
    // missing CSV before streaming. ──
    const sources = resolveQuerySources(ids, context, {
      preferCsvOverWarehouse: true,
      requireStoredCsv: true,
    });
    if (!sources.ok) return validationErrorResponse(sources);
    const { warehouseState, codeGenModel, uiComposeModel, sandboxRuntime } = sources;

    // Shared mutable run state — the disconnect handler must see the
    // warehouse-materialized csvId (see run-ask-query.ts).
    const runState: InvestigateRunState = { csvId: ids.csvId, question };

    return patchStreamResponse(
      "/api/query/investigate",
      request,
      (stream) =>
        runInvestigateQuery({
          context,
          question,
          warehouseId,
          warehouseState,
          codeGenModel,
          uiComposeModel,
          sandboxRuntime,
          runState,
          stream,
        }),
      // Client disconnected mid-run → persist history server-side, same as Ask.
      // Investigate runs are longer (multi-step, 21-min budget) and therefore
      // MORE likely to hit a disconnect; previously only Ask had this and a
      // dropped investigation lost its entire (expensive) result.
      (stream) => persistHistoryOnDisconnect(stream, runState.csvId, question)
    );
  } catch (err) {
    return apiError("/api/query/investigate", err, "Investigate failed");
  }
}
