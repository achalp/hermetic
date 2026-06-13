/**
 * Recompose an Investigate dashboard from the (possibly re-run) audit trail.
 *
 * After a notebook step re-run, the composed dashboard still reflects the
 * original results. Rather than only flagging it stale, this endpoint
 * reconstructs the sub-question results from the cached trace, re-runs the
 * investigate composer, assembles the full dashboard spec server-side
 * (placeholders resolved against the updated per-step data), and returns it
 * so the client can swap it in.
 *
 * Returns the assembled spec as JSON (one composer call — no need to stream).
 */

import { applySpecPatch, parseSpecStreamLine, type Spec } from "@json-render/core";
import { getCachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import { getStoredCSV } from "@/lib/csv/storage";
import { composeInvestigation } from "@/lib/llm/investigate-composer";
import { resolveSpecPlaceholders } from "@/lib/llm/resolve-placeholders";
import type { SubQuestionResult } from "@/lib/pipeline/investigate-orchestrator";
import type { TraceStep } from "@/lib/pipeline/investigation-trace";
import { isValidModelId, UI_COMPOSE_MODEL } from "@/lib/constants";
import { logger } from "@/lib/logger";

export const maxDuration = 300;

/** Rebuild a minimal SubQuestionResult the composer can consume from a step. */
function subResultFromStep(step: TraceStep): SubQuestionResult {
  return {
    index: step.index,
    question: step.question,
    rationale: step.rationale,
    depends_on: step.depends_on,
    removed: step.status === "removed",
    error: step.status === "failed" ? (step.error ?? "failed") : undefined,
    degraded: step.status === "degraded",
    degradedReason: step.degradedReason,
    startedAt: 0,
    finishedAt: 0,
    result:
      step.status === "success" || step.status === "degraded"
        ? ({
            generatedCode: step.code ?? "",
            question: step.question,
            executionResult: {
              success: true,
              results: step.results ?? {},
              chart_data: step.chart_data ?? {},
              datasets: step.datasets ?? {},
              images: {},
              execution_ms: step.execution_ms ?? 0,
            },
          } as SubQuestionResult["result"])
        : undefined,
  };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { csv_id?: string; ui_compose_model?: string };
    const csvId = body.csv_id;
    if (!csvId) {
      return Response.json({ error: "csv_id required" }, { status: 400 });
    }

    const prior = getCachedArtifacts(csvId);
    const trace = prior?.investigation;
    if (!prior || !trace) {
      return Response.json(
        { error: "No investigation trail cached for this dataset (it may have expired)." },
        { status: 404 }
      );
    }
    const stored = getStoredCSV(csvId);
    if (!stored) {
      return Response.json({ error: "CSV not found or expired" }, { status: 404 });
    }

    const uiComposeModel =
      body.ui_compose_model && isValidModelId(body.ui_compose_model)
        ? body.ui_compose_model
        : UI_COMPOSE_MODEL;

    const subResults = trace.steps.map(subResultFromStep);
    const compose = composeInvestigation({
      originalQuestion: trace.originalQuestion,
      plan: {
        approach: trace.approach,
        subQuestions: trace.steps.map((s) => ({
          question: s.question,
          rationale: s.rationale,
          depends_on: s.depends_on,
        })),
      },
      schema: stored.schema,
      subResults,
      uiComposeModel,
    });

    const mergedResults = compose.initialState.results;
    const mergedChartData = compose.initialState.chart_data;

    // Seed state so citation gating (__plan) and caveat banners
    // (__dataQuality / __grounding) keep working on the recomposed spec.
    const dataQuality = {
      degraded: trace.steps
        .filter((s) => s.status === "degraded")
        .map((s) => ({ stepNo: s.stepNo, question: s.question, reason: s.degradedReason })),
      failed: trace.steps
        .filter((s) => s.status === "failed")
        .map((s) => ({ stepNo: s.stepNo, question: s.question, error: s.error })),
      removed: trace.steps
        .filter((s) => s.status === "removed")
        .map((s) => ({ stepNo: s.stepNo, question: s.question })),
    };
    const spec: Spec = {
      root: "",
      elements: {},
      state: {
        __results: mergedResults,
        __chart_data: mergedChartData,
        __plan: {
          approach: trace.approach,
          steps: trace.steps.map((s) => ({
            index: s.index,
            question: s.question,
            rationale: s.rationale,
            depends_on: s.depends_on,
            status: s.status === "success" ? "done" : s.status,
          })),
        },
        __dataQuality: dataQuality,
        ...(trace.grounding ? { __grounding: trace.grounding } : {}),
      },
    };

    let buffer = "";
    let applied = 0;
    const ingest = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("```")) return;
      const resolved = resolveSpecPlaceholders(trimmed, mergedResults, mergedChartData);
      const patch = parseSpecStreamLine(resolved);
      if (!patch) return;
      try {
        applySpecPatch(spec, patch);
        applied++;
      } catch {
        // best-effort assembly
      }
    };
    for await (const chunk of compose.textStream) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) ingest(line);
    }
    if (buffer.trim()) ingest(buffer);

    if (!spec.root || applied === 0) {
      return Response.json(
        { error: "Recomposition produced an empty dashboard." },
        { status: 502 }
      );
    }

    logger.info("Investigate: dashboard recomposed", {
      csvId,
      elements: Object.keys(spec.elements).length,
    });
    return Response.json({ ok: true, spec });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Recompose failed";
    logger.error("Recompose endpoint failed", { error: msg });
    return Response.json({ error: msg }, { status: 500 });
  }
}
