/**
 * Single-step re-run for notebook mode.
 *
 * Re-executes ONE investigation step's Python (optionally edited), updates
 * that step in the cached audit trail, recomposes its notebook cell, and
 * returns the transitive dependents so the client can flag them stale.
 *
 * Scope (Phase 3 of the notebook spec): the step re-runs standalone over
 * the source data — the investigation DAG is semantic, so dependents are
 * *flagged* rather than automatically recomputed; the client offers
 * "re-run stale cells" which walks them in ascending (= topological)
 * order through this same endpoint. The unified dashboard spec is NOT
 * recomposed — the client surfaces a staleness notice instead.
 */

import {
  getStoredCSV,
  getCSVContent,
  getGeoJSONContent,
  isLocalFile,
  storeCSV,
} from "@/lib/csv/storage";
import { runPipelineWithCode } from "@/lib/pipeline/orchestrator";
import { cacheArtifacts, getCachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import { type TraceStep } from "@/lib/contracts/investigation";
import { capDatasets, transitiveDependents } from "@/lib/pipeline/investigation-trace";
import { composeStepCell } from "@/lib/llm/step-cell-composer";
import {
  buildStepFrames,
  primaryFrameCsv,
  stepFramePath,
  type StepFrameSource,
} from "@/lib/pipeline/step-frames";
import { parseCSV } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { randomUUID } from "crypto";
import type { AdditionalFile } from "@/lib/sandbox";
import { LOCAL_MOUNT_PATH } from "@/lib/constants";
import type { SandboxRuntimeId } from "@/lib/constants";
import { getActiveSandboxRuntime, getActiveModels } from "@/lib/runtime-config";
import { logger, errMessage } from "@/lib/logger";
import { apiError } from "@/app/lib/api-error";
import { trackRouteCost } from "@/lib/cost/epilogue";
import path from "node:path";

export const maxDuration = 300;

export async function POST(request: Request) {
  // Cost tracking: a step re-run recomposes a notebook cell (LLM call) that
  // previously escaped the cost log (see lib/cost/epilogue.ts trackRouteCost).
  return trackRouteCost({ mode: "rerun-step" }, () => handleRerunStep(request));
}

async function handleRerunStep(request: Request) {
  try {
    const body = (await request.json()) as {
      csv_id?: string;
      step_index?: number;
      code?: string;
      sandbox_runtime?: string;
      ui_compose_model?: string;
    };

    const { csv_id, step_index } = body;
    if (!csv_id) {
      return Response.json({ error: "csv_id required" }, { status: 400 });
    }
    if (typeof step_index !== "number" || !Number.isInteger(step_index) || step_index < 0) {
      return Response.json({ error: "step_index required" }, { status: 400 });
    }

    const prior = getCachedArtifacts(csv_id);
    const trace = prior?.investigation;
    if (!prior || !trace) {
      return Response.json(
        { error: "No investigation trail cached for this dataset (it may have expired)." },
        { status: 404 }
      );
    }
    const step = trace.steps.find((s) => s.index === step_index);
    if (!step) {
      return Response.json(
        { error: `Step ${step_index} not found in the trail.` },
        { status: 404 }
      );
    }
    if (step.status === "removed") {
      return Response.json({ error: "This step was dropped by the re-planner." }, { status: 400 });
    }

    const code = (body.code ?? step.code ?? "").trim();
    if (!code) {
      return Response.json({ error: "This step has no code to run." }, { status: 400 });
    }

    // Per-step-SQL warehouse steps ran over their OWN result CSV (stepCsvId),
    // not the top-level materialized one — re-run the step's Python against
    // that data so its columns line up. Fall back to the top-level CSV.
    const dataCsvId = step.stepCsvId && getStoredCSV(step.stepCsvId) ? step.stepCsvId : csv_id;
    const stored = getStoredCSV(dataCsvId);
    if (!stored) {
      return Response.json({ error: "csv data not found (may have expired)" }, { status: 404 });
    }

    // Source resolution mirrors the investigate route (incl. local mounts).
    const isLocal = isLocalFile(dataCsvId);
    const csvContent = isLocal ? "" : ((await getCSVContent(dataCsvId)) ?? "");
    const geojsonContent = stored.schema.has_geojson ? await getGeoJSONContent(dataCsvId) : null;
    let localMountPath: string | undefined;
    if (isLocal) {
      const hostPath = stored.localFolderPath || stored.localPath;
      if (!hostPath) {
        return Response.json({ error: "Local file path not found" }, { status: 500 });
      }
      localMountPath = stored.localFolderPath
        ? LOCAL_MOUNT_PATH
        : `${LOCAL_MOUNT_PATH}/${path.basename(hostPath)}`;
    }

    // Golden source: runtime from shared settings only.
    const runtime: SandboxRuntimeId = getActiveSandboxRuntime();

    // Dataflow: feed this step's upstream outputs as /data/step_N.csv so
    // re-running a dependent recomputes against the changed upstream output.
    // Prefer each upstream's FULL persisted output frame (outputCsvId); fall
    // back to the trace's row-capped preview only if that store has expired.
    const depFiles: AdditionalFile[] = [];
    for (const d of step.depends_on) {
      const up = trace.steps.find((s) => s.index === d);
      if (!up) continue;
      const full = up.outputCsvId ? await getCSVContent(up.outputCsvId) : null;
      if (full && full.trim()) {
        depFiles.push({ path: stepFramePath(up.stepNo), content: full });
      } else {
        const fb = buildStepFrames([
          {
            stepNo: up.stepNo,
            datasets: up.datasets,
            chart_data: up.chart_data,
          } as StepFrameSource,
        ]);
        depFiles.push(...fb.files);
      }
    }

    let pipelineResult;
    try {
      pipelineResult = await runPipelineWithCode(code, csvContent, step.question, {
        runtime,
        geojsonContent: geojsonContent ?? undefined,
        csvId: dataCsvId,
        localMountPath,
        additionalFiles: depFiles.length > 0 ? depFiles : undefined,
      });
    } catch (err) {
      logger.warn("Step rerun execution failed", {
        csv_id,
        step_index,
        error: errMessage(err),
      });
      return apiError("/api/query/investigate/rerun-step", err, String(err), 422);
    }

    const exec = pipelineResult.executionResult;
    const results = (exec.results ?? {}) as Record<string, unknown>;
    const chartData = (exec.chart_data ?? {}) as Record<string, unknown>;

    // Recompose the notebook cell for the fresh results (best-effort).
    // Golden source: compose model from shared settings only.
    const uiComposeModel = getActiveModels().uiCompose;
    const cellSpec = await composeStepCell({
      stepNo: step.stepNo,
      question: step.question,
      rationale: step.rationale,
      originalQuestion: trace.originalQuestion,
      approach: trace.approach,
      results,
      chartData,
      uiComposeModel,
    });

    // Persist the re-run step's FULL output frame so a subsequent dependent
    // re-run (e.g. the "re-run stale cells" cascade) flows the updated
    // upstream output at full fidelity, not the row-capped preview.
    let outputCsvId = step.outputCsvId;
    try {
      const frameCsv = primaryFrameCsv({
        stepNo: step.stepNo,
        datasets: (exec.datasets ?? {}) as Record<string, Record<string, unknown>[]>,
        chart_data: chartData,
      });
      if (frameCsv) {
        const id = randomUUID();
        await storeCSV(id, frameCsv, extractSchema(parseCSV(frameCsv), id, "step_output"));
        outputCsvId = id;
      }
    } catch (err) {
      logger.warn("Step rerun: failed to persist output frame", {
        step_index,
        error: errMessage(err),
      });
    }

    // Update the step in place — the cached entry shares the trace ref, but
    // re-cache explicitly to refresh the TTL for the now-active trail.
    const updated: TraceStep = {
      ...step,
      status: "success",
      code,
      results,
      chart_data: chartData,
      datasets: capDatasets((exec.datasets ?? {}) as Record<string, Record<string, unknown>[]>),
      execution_ms: exec.execution_ms ?? 0,
      degradedReason: undefined,
      error: undefined,
      cellSpec: cellSpec ?? step.cellSpec,
      outputCsvId,
    };
    const stepPos = trace.steps.findIndex((s) => s.index === step_index);
    trace.steps[stepPos] = updated;
    cacheArtifacts(csv_id, { ...prior, investigation: trace });

    const dependents = transitiveDependents(trace.steps, step_index);

    return Response.json({
      ok: true,
      step: updated,
      dependents,
    });
  } catch (err) {
    return apiError("/api/query/investigate/rerun-step", err, "Step rerun failed");
  }
}
