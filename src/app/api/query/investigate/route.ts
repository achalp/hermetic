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
import { cacheArtifacts } from "@/lib/pipeline/artifacts-cache";
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

          // ── Step 2: Execute sub-questions ──
          let stepCount = 1;
          const subResults = await runInvestigation(plan.subQuestions, {
            schema: stored.schema,
            csvContent,
            geojsonContent,
            workbookContext: undefined,
            localMountPath,
            localFileContext,
            runtime: sandboxRuntime,
            model: codeGenModel,
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
              } else if (event.kind === "sub_failed" && event.index !== undefined) {
                emit(
                  JSON.stringify({
                    op: "replace",
                    path: `/state/__plan/steps/${event.index}/status`,
                    value: "failed",
                  }) + "\n"
                );
              }
            },
          });

          if (closed) return;

          // Cache artifacts under the csvId so the artifacts panel can show
          // the most recent step's code (best-effort — investigations have
          // multiple codes; surface the LAST successful one).
          const lastSuccess = [...subResults].reverse().find((r) => r.result);
          if (lastSuccess?.result) {
            cacheArtifacts(csvId!, {
              code: lastSuccess.result.generatedCode,
              question,
              results: lastSuccess.result.executionResult.results as Record<string, unknown>,
              chart_data: lastSuccess.result.executionResult.chart_data as Record<string, unknown>,
              datasets: (lastSuccess.result.executionResult.datasets ?? {}) as Record<
                string,
                Record<string, unknown>[]
              >,
              execution_ms: lastSuccess.result.executionResult.execution_ms ?? 0,
            });
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
              emit(resolved + "\n");
            }
          }
          if (buffer.trim() && !buffer.trim().startsWith("```")) {
            const resolved = resolveSpecPlaceholders(buffer.trim(), mergedResults, mergedChartData);
            emit(resolved + "\n");
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
