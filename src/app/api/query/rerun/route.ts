/**
 * Edit-and-rerun endpoint (v1).
 *
 * Takes the user-edited Python code from the Artifacts panel, runs it in
 * the sandbox using the same data source as the original analysis, and
 * returns the new computed artifacts (results, chart_data, datasets, sql).
 *
 * NOT in v1: re-composing the dashboard spec from the new artifacts.
 * The dashboard stays as-is until the user asks a follow-up question.
 *
 * Flow:
 *  1. Look up the existing CSV / warehouse data source by csv_id
 *  2. Re-execute the edited code via `runPipelineWithCode`
 *  3. Replace the cached artifacts so the Artifacts panel shows new values
 *  4. Return the new artifacts as JSON (no spec stream)
 */

import { getStoredCSV, getCSVContent, getGeoJSONContent } from "@/lib/csv/storage";
import { runPipelineWithCode } from "@/lib/pipeline/orchestrator";
import { cacheArtifacts, getCachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import { isValidRuntimeId } from "@/lib/constants";
import type { SandboxRuntimeId } from "@/lib/constants";
import { logger } from "@/lib/logger";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";

export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      csv_id?: string;
      code?: string;
      sandbox_runtime?: string;
      sql?: string; // for warehouse-sourced analyses, preserved untouched
    };

    const { csv_id, code, sandbox_runtime } = body;

    if (!csv_id) {
      return Response.json({ error: "csv_id required" }, { status: 400 });
    }
    if (!code || typeof code !== "string" || code.trim().length === 0) {
      return Response.json({ error: "code required" }, { status: 400 });
    }

    const stored = getStoredCSV(csv_id);
    if (!stored) {
      return Response.json({ error: "csv data not found (may have expired)" }, { status: 404 });
    }

    // Look up the prior question from the cached artifacts; we re-cache with the same question
    const prior = getCachedArtifacts(csv_id);
    const question = prior?.question ?? "edited code";

    const csvContent = (await getCSVContent(csv_id)) ?? "";
    const geojsonContent = await getGeoJSONContent(csv_id);

    const runtime: SandboxRuntimeId =
      sandbox_runtime && isValidRuntimeId(sandbox_runtime)
        ? sandbox_runtime
        : getActiveSandboxRuntime();

    let pipelineResult;
    try {
      pipelineResult = await runPipelineWithCode(code, csvContent, question, {
        runtime,
        geojsonContent: geojsonContent ?? undefined,
        csvId: csv_id,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("Rerun execution failed", { csv_id, error: msg });
      return Response.json({ error: msg }, { status: 422 });
    }

    const { executionResult } = pipelineResult;
    const cachedArtifactData = {
      code,
      question,
      results: executionResult.results as Record<string, unknown>,
      chart_data: executionResult.chart_data as Record<string, unknown>,
      datasets: (executionResult.datasets ?? {}) as Record<string, Record<string, unknown>[]>,
      execution_ms: executionResult.execution_ms ?? 0,
      sql: prior?.sql, // preserve any prior SQL artifact for warehouse runs
      // Preserve the investigation audit trail: re-running one step's code
      // must not destroy the trace the Trail tab is rendering from.
      investigation: prior?.investigation,
    };
    cacheArtifacts(csv_id, cachedArtifactData);

    return Response.json({
      ok: true,
      artifacts: cachedArtifactData,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Rerun failed";
    logger.error("Rerun endpoint failed", { error: msg });
    return Response.json({ error: msg }, { status: 500 });
  }
}
