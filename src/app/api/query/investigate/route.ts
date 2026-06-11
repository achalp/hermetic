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

import { generatePlan } from "@/lib/llm/investigate-planner";
import { runInvestigation } from "@/lib/pipeline/investigate-orchestrator";
import { composeInvestigation } from "@/lib/llm/investigate-composer";
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
import { getStoredCSV, getCSVContent, getGeoJSONContent, isLocalFile } from "@/lib/csv/storage";
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
    const csvId = context.csv_id;
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

    // v1: only file-source investigations. Warehouse investigations would
    // need to plan + execute SQL separately for each sub-question. Defer.
    if (warehouseId && !csvId) {
      return new Response(
        JSON.stringify({
          error:
            "Investigate mode currently supports file-source analyses only. Run a warehouse query first (which materializes a CSV), then re-run with Investigate.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    const stored = getStoredCSV(csvId!);
    if (!stored) {
      return new Response(JSON.stringify({ error: "CSV not found or expired" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
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
        return new Response(JSON.stringify({ error: "Local file path not found" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Use the existing constants — same shape as /api/query
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

          // ── Step 2: Execute sub-questions (with re-planning between waves) ──
          let stepCount = 1;

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
              } else if (event.kind === "sub_failed" && event.index !== undefined) {
                emit(
                  JSON.stringify({
                    op: "replace",
                    path: `/state/__plan/steps/${event.index}/status`,
                    value: "failed",
                  }) + "\n"
                );
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
                sql: prior?.sql,
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

          const ingestComposedLine = (preResolution: string, resolved: string) => {
            // Raw line: only unambiguous $result/$chartData placeholders count
            // as citations — prose-scanning the raw JSON would match element
            // IDs / key paths named after steps and suppress the
            // uncited-steps advisory.
            for (const n of extractPlaceholderCitedSteps(preResolution)) citedSteps.add(n);
            try {
              const patch = JSON.parse(resolved) as { value?: unknown };
              if (patch && "value" in patch) {
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
