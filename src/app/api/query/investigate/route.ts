/**
 * Investigate endpoint — runs a multi-step deep analysis.
 *
 * Flow:
 *   1. Plan: decompose the user question into 3-5 sub-questions
 *   2. Execute: run each sub-question through the existing pipeline
 *      (parallel for independents, serial for dependents)
 *   3. Compose: synthesize one unified dashboard spec from all sub-results
 *   4. Stream the spec back via the same JSONL patch protocol /api/query
 *      uses, plus per-step progress events surfaced as state patches.
 *
 * Privacy: same schema-only model as Ask. Each sub-question's LLM call
 * sees only the schema + statistics, never row values. The composer sees
 * aggregated RESULTS (scalars, chart data shapes), never raw rows.
 */

import type { Spec } from "@json-render/core";
import { generatePlan } from "@/lib/llm/investigate-planner";
import {
  runInvestigation,
  type InvestigateProgressEvent,
} from "@/lib/pipeline/investigate-orchestrator";
import { composeInvestigation } from "@/lib/llm/investigate-composer";
import { composeStepCell } from "@/lib/llm/step-cell-composer";
import { resolveSpecPlaceholders } from "@/lib/llm/resolve-placeholders";
import { cacheArtifacts, getCachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import {
  buildInvestigationTrace,
  successfulStepNos,
  type TraceDecision,
  type StepSource,
} from "@/lib/pipeline/investigation-trace";
import {
  collectGroundedValues,
  verifyGrounding,
  extractCitedSteps,
  extractPlaceholderCitedSteps,
} from "@/lib/pipeline/grounding";
import {
  getStoredCSV,
  getCSVContent,
  getGeoJSONContent,
  isLocalFile,
  storeCSV,
} from "@/lib/csv/storage";
import { getStoredWarehouse, getWarehouseConnector } from "@/lib/warehouse/storage";
import { generateSQL } from "@/lib/warehouse/sql-generation";
import { parseCSV } from "@/lib/csv/parser";
import { extractSchema } from "@/lib/csv/schema";
import { randomUUID } from "crypto";
import {
  CODE_GEN_MODEL,
  UI_COMPOSE_MODEL,
  isValidModelId,
  isValidRuntimeId,
} from "@/lib/constants";
import type { SandboxRuntimeId } from "@/lib/constants";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import { getActiveProvider } from "@/lib/llm/client";
import { logger } from "@/lib/logger";

export const maxDuration = 600; // 10 minutes — investigations can run longer than Ask

/**
 * Narrative-bearing prop keys in a JSON-Render component node. We collect text
 * from these (not every string) so the grounding pass checks prose and labels
 * but ignores type names, variants, colors, and key paths — which contain
 * digit sequences (hex colors, step_N keys) that would be false positives.
 */
const NARRATIVE_KEYS = new Set([
  "content",
  "label",
  "title",
  "caption",
  "description",
  "summary",
  "text",
]);

/** Recursively pull narrative strings out of a streamed patch's `value`. */
function collectNarrativeStrings(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 8 || value == null) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectNarrativeStrings(item, depth + 1, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string") {
        if (NARRATIVE_KEYS.has(k)) out.push(v);
      } else {
        collectNarrativeStrings(v, depth + 1, out);
      }
    }
  }
  return out;
}

interface InvestigateContext {
  csv_id?: string;
  warehouse_id?: string;
  question?: string;
  code_gen_model?: string;
  ui_compose_model?: string;
  sandbox_runtime?: string;
}

interface InvestigateBody {
  prompt?: string;
  context?: InvestigateContext;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as InvestigateBody;
    const context = body.context ?? {};
    let csvId = context.csv_id;
    const warehouseId = context.warehouse_id;
    const question = (context.question ?? body.prompt ?? "").trim();

    if (!csvId && !warehouseId) {
      return new Response(
        JSON.stringify({ error: "csv_id or warehouse_id is required in context" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    if (!question) {
      return new Response(JSON.stringify({ error: "question is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Investigate is a heavyweight cloud-LLM operation. Local backends are
    // gated at the UI level; refuse here as a safety net.
    let activeProvider: string;
    try {
      activeProvider = getActiveProvider();
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err instanceof Error ? err.message : "No LLM configured" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }
    if (activeProvider === "ollama" || activeProvider === "mlx" || activeProvider === "llama-cpp") {
      return new Response(
        JSON.stringify({
          error:
            "Investigate mode requires a cloud LLM provider (Anthropic, Bedrock, Vertex, or OpenAI-compatible). Local models plan and synthesize multi-step investigations poorly. Switch in Settings or use Ask instead.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Validate model IDs (only for cloud providers)
    const codeGenModel: string =
      context.code_gen_model && isValidModelId(context.code_gen_model)
        ? context.code_gen_model
        : CODE_GEN_MODEL;
    const uiComposeModel: string =
      context.ui_compose_model && isValidModelId(context.ui_compose_model)
        ? context.ui_compose_model
        : UI_COMPOSE_MODEL;
    const sandboxRuntime: SandboxRuntimeId =
      context.sandbox_runtime && isValidRuntimeId(context.sandbox_runtime)
        ? context.sandbox_runtime
        : getActiveSandboxRuntime();

    // Warehouse investigations: materialize the data with ONE broad SQL
    // pull, then run the standard file-source investigation over the
    // resulting CSV. Per-step SQL (each sub-question generating its own
    // query) remains the deeper fast-follow — see specs/notebook-mode.
    // Validate the connection before streaming so failures are clean 404s.
    let warehouseState: {
      warehouse: NonNullable<ReturnType<typeof getStoredWarehouse>>;
      connector: NonNullable<ReturnType<typeof getWarehouseConnector>>;
    } | null = null;
    if (warehouseId && !csvId) {
      const warehouse = getStoredWarehouse(warehouseId);
      if (!warehouse) {
        return new Response(
          JSON.stringify({ error: "Warehouse not found or expired. Please reconnect." }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }
      const connector = getWarehouseConnector(warehouseId);
      if (!connector) {
        return new Response(JSON.stringify({ error: "Warehouse connector not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      warehouseState = { warehouse, connector };
    } else if (!getStoredCSV(csvId!)) {
      return new Response(JSON.stringify({ error: "CSV not found or expired" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── Stream begins ──
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        let closed = false;
        const emit = (data: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(data));
          } catch {
            closed = true;
          }
        };

        const keepalive = setInterval(() => emit(": keepalive\n"), 15_000);

        const emitProgress = (stage: string, step: number, total: number) => {
          const patch =
            step === 1
              ? {
                  op: "add",
                  path: "/state",
                  value: { __progress: { stage, step, total } },
                }
              : {
                  op: "replace",
                  path: "/state/__progress",
                  value: { stage, step, total },
                };
          emit(JSON.stringify(patch) + "\n");
        };

        try {
          // ── Step 0 (warehouse only): materialize via one broad SQL pull ──
          // The pull is intentionally row-level (not pre-aggregated): the
          // sub-questions aren't known yet, so the materialized CSV must
          // leave room for whatever angles the planner takes.
          let warehouseSQL: string | undefined;
          if (warehouseState) {
            const { warehouse, connector } = warehouseState;
            emitProgress("generating_sql", 1, 99);
            const materializationQuestion =
              `Retrieve the DETAILED rows needed to investigate this question from multiple angles: ${question}\n` +
              `Return row-level data (not pre-aggregated summaries) and include every column plausibly relevant to the question — ` +
              `dimensions for grouping, dates for trends, and measures for computation. Cap the result at 50000 rows if the source is larger.`;
            warehouseSQL = await generateSQL(
              warehouse.tableSchemas,
              materializationQuestion,
              warehouse.config.type,
              codeGenModel
            );
            logger.info("Investigate: warehouse SQL generated", { sql: warehouseSQL });

            emitProgress("querying_warehouse", 1, 99);
            const warehouseCsvContent = await connector.executeSQL(warehouseSQL);
            if (!warehouseCsvContent || warehouseCsvContent.trim() === "") {
              throw new Error(`SQL query returned no results.\n\nGenerated SQL:\n${warehouseSQL}`);
            }
            const parsed = parseCSV(warehouseCsvContent);
            const newCsvId = randomUUID();
            const schema = extractSchema(parsed, newCsvId, "warehouse_query_result");
            schema.source_type = "warehouse";
            schema.warehouse_type = warehouse.config.type;
            await storeCSV(newCsvId, warehouseCsvContent, schema);
            csvId = newCsvId;
            logger.info("Investigate: warehouse data materialized", {
              csvId: newCsvId,
              columns: schema.columns.length,
            });
            // Emit the generated csvId so the client can use it for
            // artifacts, notebook cell re-runs, and follow-ups.
            emit(
              JSON.stringify({
                op: "add",
                path: "/state/__warehouse_csv_id",
                value: newCsvId,
              }) + "\n"
            );
          }

          // ── Resolve the source (file upload, local mount, or the CSV
          //     just materialized from the warehouse) ──
          const stored = getStoredCSV(csvId!);
          if (!stored) {
            throw new Error("CSV not found or expired");
          }
          const isLocal = isLocalFile(csvId!);
          const csvContent = isLocal ? "" : ((await getCSVContent(csvId!)) ?? "");
          const geojsonContent = stored.schema.has_geojson ? await getGeoJSONContent(csvId!) : null;

          // Local-mount path resolution (mirrors the logic in /api/query)
          let localMountPath: string | undefined;
          let localFileContext: string | undefined;
          if (isLocal) {
            const hostPath = stored.localFolderPath || stored.localPath;
            if (!hostPath) {
              throw new Error("Local file path not found");
            }
            const { LOCAL_MOUNT_PATH } = await import("@/lib/constants");
            const path = await import("node:path");
            if (stored.localFolderPath) {
              localMountPath = LOCAL_MOUNT_PATH;
              localFileContext = `The dataset is a folder of Parquet files mounted at ${LOCAL_MOUNT_PATH}. Use DuckDB: con.execute("SELECT * FROM read_parquet('${LOCAL_MOUNT_PATH}/**/*.parquet')").df().`;
            } else {
              const fname = path.basename(hostPath);
              localMountPath = `${LOCAL_MOUNT_PATH}/${fname}`;
              localFileContext = `The data file is mounted at /data/local/${fname}. Read with: pd.read_csv("/data/local/${fname}")`;
            }
          }

          // ── Step 1: Plan ──
          emitProgress("planning", 1, 99);
          const planResult = await generatePlan(question, stored.schema, undefined, codeGenModel);
          if (!planResult.ok) {
            throw new Error(`Plan generation failed: ${planResult.error}`);
          }
          const plan = planResult.plan;
          const totalSteps = plan.subQuestions.length + 2; // +1 plan, +1 compose

          // Surface the plan to the client immediately so the user sees structure
          emit(
            JSON.stringify({
              op: "add",
              path: "/state/__plan",
              value: {
                approach: plan.approach,
                steps: plan.subQuestions.map((sq, i) => ({
                  index: i,
                  question: sq.question,
                  rationale: sq.rationale,
                  depends_on: sq.depends_on,
                  status: "pending",
                })),
              },
            }) + "\n"
          );

          // Notebook cells: container for per-step composed mini-specs.
          // Cells stream in as `/state/__cells/{index}` the moment each
          // step's compose finishes — the notebook view fills in live.
          emit(JSON.stringify({ op: "add", path: "/state/__cells", value: {} }) + "\n");

          // ── Step 2: Execute sub-questions (with re-planning between waves) ──
          let stepCount = 1;

          // Per-step cell composes, dispatched on sub_finished/sub_degraded
          // so they run concurrently with later waves' sandbox execution.
          // Best-effort: a failed compose just leaves the cell as a stub.
          const cellSpecs = new Map<number, Spec>();
          const cellComposes: Promise<void>[] = [];
          const dispatchCellCompose = (event: InvestigateProgressEvent) => {
            const sub = event.stepResult;
            const exec = sub?.result?.executionResult;
            if (!sub || !exec || event.index === undefined) return;
            const index = event.index;
            cellComposes.push(
              composeStepCell({
                stepNo: index + 1,
                question: sub.question,
                rationale: sub.rationale,
                originalQuestion: question,
                approach: plan.approach,
                results: (exec.results ?? {}) as Record<string, unknown>,
                chartData: (exec.chart_data ?? {}) as Record<string, unknown>,
                degraded: sub.degraded,
                degradedReason: sub.degradedReason,
                uiComposeModel,
              }).then((spec) => {
                if (!spec) return;
                cellSpecs.set(index, spec);
                emit(
                  JSON.stringify({
                    op: "add",
                    path: `/state/__cells/${index}`,
                    value: { status: sub.degraded ? "degraded" : "success", cellSpec: spec },
                  }) + "\n"
                );
              })
            );
          };

          // Accumulate the audit trail's decision log and per-step provenance
          // from the orchestrator's progress events. The events are the only
          // place the re-planner's and composer's rationales surface, so we
          // capture them here for the trace the artifacts panel renders.
          const decisions: TraceDecision[] = [];
          const sourceByIndex = new Map<number, StepSource>();
          // subs_amended events carry their provenance (amendmentSource), so
          // attribution never depends on event ordering. currentReplan only
          // tracks the most recent replan decision so a re-planner amendment
          // can fill in its added/removed indices.
          let currentReplan: TraceDecision | null = null;
          let pendingComposerAdded: number[] = [];

          const subResults = await runInvestigation(plan.subQuestions, {
            schema: stored.schema,
            csvContent,
            geojsonContent,
            workbookContext: undefined,
            localMountPath,
            localFileContext,
            runtime: sandboxRuntime,
            model: codeGenModel,
            originalQuestion: question,
            approach: plan.approach,
            // Warehouse table schemas inform the re-planner what ELSE could
            // be queried, even though v1 sub-questions run over the
            // materialized CSV.
            warehouse: warehouseState?.warehouse.tableSchemas,
            onProgress: (event) => {
              if (event.kind === "sub_started" && event.index !== undefined) {
                stepCount++;
                emitProgress("investigating", stepCount, totalSteps);
                emit(
                  JSON.stringify({
                    op: "replace",
                    path: `/state/__plan/steps/${event.index}/status`,
                    value: "running",
                  }) + "\n"
                );
              } else if (event.kind === "sub_finished" && event.index !== undefined) {
                emit(
                  JSON.stringify({
                    op: "replace",
                    path: `/state/__plan/steps/${event.index}/status`,
                    value: "done",
                  }) + "\n"
                );
                dispatchCellCompose(event);
              } else if (event.kind === "sub_degraded" && event.index !== undefined) {
                emit(
                  JSON.stringify({
                    op: "replace",
                    path: `/state/__plan/steps/${event.index}/status`,
                    value: "degraded",
                  }) + "\n"
                );
                if (event.degradedReason) {
                  emit(
                    JSON.stringify({
                      op: "add",
                      path: `/state/__plan/steps/${event.index}/degradedReason`,
                      value: event.degradedReason,
                    }) + "\n"
                  );
                }
                dispatchCellCompose(event);
              } else if (event.kind === "sub_failed" && event.index !== undefined) {
                emit(
                  JSON.stringify({
                    op: "replace",
                    path: `/state/__plan/steps/${event.index}/status`,
                    value: "failed",
                  }) + "\n"
                );
                if (event.error) {
                  // Surface the failure reason so the notebook's failed-cell
                  // stub can show it live (the trace carries it post-stream).
                  emit(
                    JSON.stringify({
                      op: "add",
                      path: `/state/__plan/steps/${event.index}/error`,
                      value: event.error.slice(0, 300),
                    }) + "\n"
                  );
                }
              } else if (event.kind === "replan_decision") {
                // Record for the audit trail. The matching subs_amended (if the
                // action was "amend") fills in added/removed indices below.
                currentReplan = {
                  kind: "replan",
                  action: event.replanAction,
                  rationale: event.replanRationale ?? "",
                  addedIndices: [],
                  removedIndices: [],
                };
                decisions.push(currentReplan);
                // Surface the re-planner's decision as a sibling entry on the plan.
                // The UI can render this inline as a "Planner re-evaluated" step.
                emit(
                  JSON.stringify({
                    op: "add",
                    path: "/state/__plan/replan",
                    value: {
                      action: event.replanAction,
                      rationale: event.replanRationale,
                      atStepCount: stepCount,
                    },
                  }) + "\n"
                );
              } else if (event.kind === "subs_amended") {
                // Audit-trail provenance, read directly off the event.
                const addedIndices = (event.addedSteps ?? []).map((s) => s.index);
                if (event.amendmentSource === "composer") {
                  pendingComposerAdded = addedIndices;
                  for (const idx of addedIndices) sourceByIndex.set(idx, "composer");
                } else if (currentReplan) {
                  currentReplan.addedIndices = addedIndices;
                  currentReplan.removedIndices = event.removedIndices ?? [];
                  for (const idx of addedIndices) sourceByIndex.set(idx, "replanner");
                  currentReplan = null;
                }
                // Append new steps to the visible plan and mark removed ones.
                if (event.addedSteps) {
                  for (const step of event.addedSteps) {
                    emit(
                      JSON.stringify({
                        op: "add",
                        path: `/state/__plan/steps/${step.index}`,
                        value: {
                          index: step.index,
                          question: step.question,
                          rationale: step.rationale,
                          depends_on: step.depends_on,
                          status: "pending",
                          addedByReplanner: event.amendmentSource !== "composer",
                          addedByComposer: event.amendmentSource === "composer",
                        },
                      }) + "\n"
                    );
                  }
                }
                if (event.removedIndices) {
                  for (const idx of event.removedIndices) {
                    emit(
                      JSON.stringify({
                        op: "replace",
                        path: `/state/__plan/steps/${idx}/status`,
                        value: "removed",
                      }) + "\n"
                    );
                  }
                }
              } else if (event.kind === "composer_dispatched") {
                // Record the composer's gap-check dispatch in the audit trail,
                // attributing the steps added by the preceding subs_amended.
                decisions.push({
                  kind: "composer_dispatch",
                  rationale: event.composerRationale ?? "",
                  addedIndices: pendingComposerAdded,
                  removedIndices: [],
                });
                pendingComposerAdded = [];
                // Surface the composer's gap-check decision. Newly added steps
                // arrive via a sibling subs_amended event with addedByReplanner.
                // Override the flag on those steps to indicate composer-source.
                emit(
                  JSON.stringify({
                    op: "add",
                    path: "/state/__plan/composerDispatch",
                    value: {
                      rationale: event.composerRationale,
                      atStepCount: stepCount,
                    },
                  }) + "\n"
                );
              }
            },
          });

          if (closed) return;

          // Build the full audit trail: every sub-question's code + result,
          // the re-planner / composer decisions, and (added after compose) the
          // grounding verdict. This is what the artifacts panel renders as a
          // re-runnable per-step trail — the agentic loop extending Hermetic's
          // "see the Python and re-run it" moat, not outrunning it.
          const trace = buildInvestigationTrace({
            approach: plan.approach,
            originalQuestion: question,
            subResults,
            sourceByIndex,
            decisions,
          });

          // Cache artifacts under the csvId. The top-level code/results mirror
          // the LAST successful step (back-compat with the single-view panel);
          // `investigation` carries the whole trail. Cached before compose so a
          // composer failure still leaves an inspectable trail; `trace.grounding`
          // is set below on the same object, so the cached entry sees it too.
          const lastSuccess = [...subResults].reverse().find((r) => r.result);
          const prior = getCachedArtifacts(csvId!);
          const topLevel = lastSuccess?.result
            ? {
                code: lastSuccess.result.generatedCode,
                question,
                results: lastSuccess.result.executionResult.results as Record<string, unknown>,
                chart_data: lastSuccess.result.executionResult.chart_data as Record<
                  string,
                  unknown
                >,
                datasets: (lastSuccess.result.executionResult.datasets ?? {}) as Record<
                  string,
                  Record<string, unknown>[]
                >,
                execution_ms: lastSuccess.result.executionResult.execution_ms ?? 0,
                // The materialization SQL for a warehouse investigation —
                // surfaces in the artifacts SQL tab.
                sql: warehouseSQL,
              }
            : {
                // Every sub-question failed: keep the previously cached
                // top-level artifacts (a failed investigation must not clobber
                // a prior good run's re-runnable code) and attach the trail.
                code: prior?.code ?? "",
                question: prior?.question ?? question,
                results: prior?.results ?? {},
                chart_data: prior?.chart_data ?? {},
                datasets: prior?.datasets ?? {},
                execution_ms: prior?.execution_ms ?? 0,
                sql: warehouseSQL ?? prior?.sql,
              };
          cacheArtifacts(csvId!, { ...topLevel, investigation: trace });

          // Deterministic data-quality surfacing — guarantees degraded / failed
          // / dropped branches reach the user regardless of whether the composer
          // remembered to annotate them. Rendered as a banner above the
          // dashboard by ResponsePanel.
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
          if (
            dataQuality.degraded.length ||
            dataQuality.failed.length ||
            dataQuality.removed.length
          ) {
            emit(
              JSON.stringify({ op: "add", path: "/state/__dataQuality", value: dataQuality }) + "\n"
            );
          }

          // ── Step 3: Compose unified dashboard ──
          stepCount++;
          emitProgress("composing", stepCount, totalSteps);

          const compose = composeInvestigation({
            originalQuestion: question,
            plan,
            schema: stored.schema,
            subResults,
            uiComposeModel,
          });

          // Inject merged data into spec.state so $result/$chartData
          // placeholders resolve client-side
          emit(
            JSON.stringify({
              op: "add",
              path: "/state/__results",
              value: compose.initialState.results,
            }) + "\n"
          );
          emit(
            JSON.stringify({
              op: "add",
              path: "/state/__chart_data",
              value: compose.initialState.chart_data,
            }) + "\n"
          );

          // Stream the composed spec — the LLM emits raw JSONL patches that
          // build the spec tree, same protocol as /api/query. Resolve
          // $result:<key> and $chartData:<key> placeholders against the
          // merged per-step results before emitting (mirrors /api/query).
          const mergedResults = compose.initialState.results;
          const mergedChartData = compose.initialState.chart_data;

          // Collect the composed narrative for the grounding pass: prose text
          // (post-resolution, so placeholder values are inlined) and the steps
          // the narrative cited (from $result:step_N_ placeholders pre-resolution
          // and "Step N" mentions post-resolution).
          const narrativeTexts: string[] = [];
          const citedSteps = new Set<number>();
          // Notebook synthesis cell: the composer is instructed to use the
          // element IDs `exec_summary` and `conclusion` for those two blocks;
          // we lift their (post-resolution) content here. Matching is
          // tolerant of the LLM's id-styling drift ("exec-summary",
          // "conclusion-block"). Best-effort — if the composer ignores the
          // IDs entirely, the notebook omits the synthesis.
          const SUMMARY_PATH_RE = /^\/elements\/exec[-_]summary(?:[-_][a-z0-9]+)?$/;
          const CONCLUSION_PATH_RE = /^\/elements\/conclusion(?:[-_][a-z0-9]+)?$/;
          const synthesis: { summary?: string; conclusion?: string } = {};

          const ingestComposedLine = (preResolution: string, resolved: string) => {
            // Raw line: only unambiguous $result/$chartData placeholders count
            // as citations — prose-scanning the raw JSON would match element
            // IDs / key paths named after steps and suppress the
            // uncited-steps advisory.
            for (const n of extractPlaceholderCitedSteps(preResolution)) citedSteps.add(n);
            try {
              const patch = JSON.parse(resolved) as { path?: string; value?: unknown };
              if (patch && "value" in patch) {
                const isSummary = !!patch.path && SUMMARY_PATH_RE.test(patch.path);
                const isConclusion =
                  !isSummary && !!patch.path && CONCLUSION_PATH_RE.test(patch.path);
                if (isSummary || isConclusion) {
                  const content = (patch.value as { props?: { content?: unknown } } | null)?.props
                    ?.content;
                  if (typeof content === "string" && content.trim()) {
                    if (isSummary) synthesis.summary = content;
                    else synthesis.conclusion = content;
                  }
                }
                for (const text of collectNarrativeStrings(patch.value)) {
                  narrativeTexts.push(text);
                  for (const n of extractCitedSteps(text)) citedSteps.add(n);
                }
              }
            } catch {
              // Non-JSON or partial line — skip; grounding is best-effort.
            }
          };

          let buffer = "";
          for await (const chunk of compose.textStream) {
            if (closed) break;
            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              if (trimmed.startsWith("```")) continue;
              const resolved = resolveSpecPlaceholders(trimmed, mergedResults, mergedChartData);
              ingestComposedLine(trimmed, resolved);
              emit(resolved + "\n");
            }
          }
          if (buffer.trim() && !buffer.trim().startsWith("```")) {
            const resolved = resolveSpecPlaceholders(buffer.trim(), mergedResults, mergedChartData);
            ingestComposedLine(buffer.trim(), resolved);
            emit(resolved + "\n");
          }

          // ── Notebook cells: settle and attach ──
          // Most cell composes finish during the waves; only the final
          // wave's may still be in flight. Their `__cells` patches emit as
          // they land (the .then handlers above); attaching to the trace
          // mutates the shared ref, so the cached artifacts entry sees the
          // cellSpecs too — notebooks reload from history for free.
          await Promise.allSettled(cellComposes);
          for (const step of trace.steps) {
            const cell = cellSpecs.get(step.index);
            if (cell) step.cellSpec = cell;
          }

          // Notebook synthesis cell content, lifted from the composed
          // narrative. Lives in spec state, so it persists with history.
          if (synthesis.summary || synthesis.conclusion) {
            emit(
              JSON.stringify({ op: "add", path: "/state/__synthesis", value: synthesis }) + "\n"
            );
          }

          // ── Grounding verdict ──
          // Verify the composed narrative against what the investigation
          // actually computed. Ungrounded figures (numbers that trace to no
          // computed value) are surfaced as an advisory caveat and recorded in
          // the trail — the guard against plausible-but-wrong, where semantic
          // validation only catches degenerate.
          if (!closed) {
            const grounded = collectGroundedValues(mergedResults, mergedChartData);
            const grounding = verifyGrounding({
              narrativeTexts,
              citedSteps: [...citedSteps].sort((a, b) => a - b),
              grounded,
              successfulStepNos: successfulStepNos(trace),
            });
            trace.grounding = grounding; // shared ref — updates the cached entry
            if (
              !grounding.ok ||
              grounding.uncitedSuccessfulSteps.length > 0 ||
              grounding.checkedCount > 0
            ) {
              emit(
                JSON.stringify({ op: "add", path: "/state/__grounding", value: grounding }) + "\n"
              );
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error("Investigate: failed", { error: msg.slice(0, 500) });
          emit(
            JSON.stringify({
              op: "add",
              path: "/state/__error",
              value: msg,
            }) + "\n"
          );
        } finally {
          clearInterval(keepalive);
          if (!closed) {
            try {
              controller.close();
            } catch {
              // already closed
            }
          }
        }
      },
      cancel() {
        // Client aborted — best-effort: subsequent emits become no-ops.
        // In-flight LLM calls and sandbox executions will continue but
        // their outputs are discarded.
      },
    });

    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Investigate failed";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
