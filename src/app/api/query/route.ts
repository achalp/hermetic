import { patchStreamResponse } from "@/lib/pipeline/patch-stream";
import { apiError, validationErrorResponse } from "@/app/lib/api-error";
import { getActiveProvider, providerCapabilities } from "@/lib/llm/client";
import { validateQueryIds, resolveQuerySources } from "@/lib/pipeline/validate-request";
import { readJsonBody, parseBody, analysisRequestSchema } from "@/lib/api-schemas";
import { persistHistoryOnDisconnect } from "@/lib/history/persist-on-disconnect";
import { runAskQuery, type AskRunState } from "@/lib/pipeline/run-ask-query";

export const maxDuration = 1260; // 21 min — matches the large-data sandbox budget (remote billion-row scans)

/**
 * Thin transport shell (modularization M3-3a): parse + validate the request,
 * then hand the PatchStream to runAskQuery — the analysis itself lives in
 * lib/pipeline/run-ask-query.ts, callable by any harness.
 */
export async function POST(request: Request) {
  // Aborted duplicate requests truncate the body — a 400, not a logged 500.
  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  try {
    const parsed = parseBody(analysisRequestSchema, read.body);
    if (!parsed.ok) return parsed.response;
    const { prompt, context } = parsed.data;

    // Local providers use their own model ids — skip Claude model-ID
    // validation. The capability lives in ONE place (providerCapabilities);
    // the hand-maintained list here had drifted to omit mlx/llama-cpp, whose
    // Ask requests silently fell back to Claude model ids.
    let skipModelValidation = false;
    try {
      skipModelValidation = providerCapabilities(getActiveProvider()).skipModelValidation;
    } catch {
      // No provider configured — will fail later in getModel()
    }

    // ── Shared preamble: ids/question 400s, warehouse 404s, model/runtime
    // resolution (lib/pipeline/validate-request.ts — same module Investigate
    // uses, so the two routes can't drift again). ──
    const ids = validateQueryIds(context ?? {}, prompt);
    if (!ids.ok) return validationErrorResponse(ids);
    const { question } = ids;

    const sources = resolveQuerySources(ids, context ?? {}, { skipModelValidation });
    if (!sources.ok) return validationErrorResponse(sources);
    const { source, codeGenModel, uiComposeModel, sandboxRuntime } = sources;

    // Shared mutable run state: a warehouse run learns its materialized csvId
    // mid-stream, and the disconnect handler must see the updated id.
    const runState: AskRunState = { csvId: ids.csvId, question };

    return patchStreamResponse(
      "/api/query",
      request,
      (stream) =>
        runAskQuery({
          context: context ?? {},
          question,
          source,
          codeGenModel,
          uiComposeModel,
          sandboxRuntime,
          runState,
          stream,
        }),
      // Client disconnected mid-run → persist history server-side (shared with
      // Investigate — see lib/history/persist-on-disconnect.ts).
      (stream) => persistHistoryOnDisconnect(stream, runState.csvId, question)
    );
  } catch (err) {
    return apiError("/api/query", err, String(err));
  }
}
