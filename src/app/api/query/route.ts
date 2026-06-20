import {
  getStoredCSV,
  getCSVContent,
  getGeoJSONContent,
  getWorkbookManifest,
  storeCSV,
  isLocalFile,
} from "@/lib/csv/storage";
import { runPipeline, runPipelineWithCode } from "@/lib/pipeline/orchestrator";
import { runWithCostTracking, getCostAccumulator, computeCost } from "@/lib/cost/accumulator";
import { appendCostRow } from "@/lib/cost/storage";
import { buildWorkbookContext, sanitizeSheetName } from "@/lib/llm/prompts";
import type { AdditionalFile } from "@/lib/sandbox";
import { cacheGeneratedCode } from "@/lib/pipeline/code-cache";
import { cacheArtifacts } from "@/lib/pipeline/artifacts-cache";
import {
  UI_COMPOSE_MODEL,
  CODE_GEN_MODEL,
  isValidModelId,
  isValidRuntimeId,
} from "@/lib/constants";
import type { SandboxRuntimeId } from "@/lib/constants";
import type { ConversationTurn, SchemaMode } from "@/lib/types";
import {
  getConversationTurns,
  appendConversationTurn,
  buildTurnFromArtifacts,
} from "@/lib/pipeline/conversation-cache";
import { composeAndStreamDashboard, type DrillDownContext } from "@/lib/pipeline/dashboard-compose";
import { logger } from "@/lib/logger";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import { getActiveProvider } from "@/lib/llm/client";
import { getStoredWarehouse, getWarehouseConnector } from "@/lib/warehouse/storage";
import { generateSQL } from "@/lib/warehouse/sql-generation";
import { randomUUID } from "crypto";
import { extractSchema } from "@/lib/csv/schema";
import { parseCSV } from "@/lib/csv/parser";

export const maxDuration = 300; // 5 min — large Parquet datasets need more time

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { prompt, context } = body;

    let csvId: string | undefined = context?.csv_id;
    const warehouseId: string | undefined = context?.warehouse_id;
    const question: string = context?.question ?? prompt ?? "";
    const drillDownContext: DrillDownContext | undefined = context?.drill_down_context;
    const schemaMode: SchemaMode = context?.schema_mode === "sample" ? "sample" : "metadata";
    const purpose: string = context?.purpose ?? "dashboard";
    /**
     * Optional pre-generated code. When provided, the route skips code-gen
     * (step 1) and runs only the sandbox-execute → UI-compose path. Used by
     * the Edit-and-Rerun feature to rebuild the dashboard from edited code.
     */
    const editedCode: string | undefined =
      typeof context?.code === "string" && context.code.trim().length > 0
        ? context.code
        : undefined;

    /**
     * Optional pre-edited SQL (warehouse sources only). When provided, the
     * route skips NL-to-SQL generation and uses the edited SQL directly.
     * The result CSV's schema is re-extracted, so the downstream Python
     * code-gen runs against the new shape. Combined with `editedCode`,
     * both LLM steps are skipped.
     */
    const editedSql: string | undefined =
      typeof context?.sql === "string" && context.sql.trim().length > 0 ? context.sql : undefined;

    // When Ollama or openai-compatible is active, skip Claude model ID validation
    // since getModel() will use the Ollama/custom model directly
    let skipModelValidation = false;
    try {
      const provider = getActiveProvider();
      skipModelValidation = provider === "ollama" || provider === "openai-compatible";
    } catch {
      // No provider configured — will fail later in getModel()
    }

    const codeGenModel: string =
      !skipModelValidation && context?.code_gen_model && isValidModelId(context.code_gen_model)
        ? context.code_gen_model
        : CODE_GEN_MODEL;
    const uiComposeModel: string =
      !skipModelValidation && context?.ui_compose_model && isValidModelId(context.ui_compose_model)
        ? context.ui_compose_model
        : UI_COMPOSE_MODEL;
    const sandboxRuntime: SandboxRuntimeId =
      context?.sandbox_runtime && isValidRuntimeId(context.sandbox_runtime)
        ? context.sandbox_runtime
        : getActiveSandboxRuntime();

    if (!csvId && !warehouseId) {
      return new Response(
        JSON.stringify({ error: "csv_id or warehouse_id is required in context" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    if (!question) {
      return new Response(JSON.stringify({ error: "question is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ── Warehouse: validate early (before streaming) ──────
    let warehouseState: {
      warehouse: NonNullable<ReturnType<typeof getStoredWarehouse>>;
      connector: NonNullable<ReturnType<typeof getWarehouseConnector>>;
    } | null = null;

    if (warehouseId) {
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
    }

    // Stream immediately — emit progress patches as the pipeline runs, then stream LLM output
    const encoder = new TextEncoder();
    const isWarehouse = !!warehouseState;
    const totalSteps = isWarehouse ? 5 : 3;

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

        const emitProgress = (stage: string, step: number) => {
          const patch =
            step === 1
              ? {
                  op: "add",
                  path: "/state",
                  value: { __progress: { stage, step, total: totalSteps } },
                }
              : {
                  op: "replace",
                  path: "/state/__progress",
                  value: { stage, step, total: totalSteps },
                };
          emit(JSON.stringify(patch) + "\n");
        };

        // Keepalive: send a no-op comment every 15 seconds to prevent
        // browsers/proxies from closing the connection during slow LLM
        // calls (llama.cpp code generation can take 2-3+ minutes).
        const keepalive = setInterval(() => {
          emit(": keepalive\n");
        }, 15_000);

        let warehouseSQL: string | undefined;
        let datasetLabel = csvId ?? warehouseId ?? "dataset";

        await runWithCostTracking(async () => {
          try {
            // ── Warehouse path: generate SQL → execute → store as CSV ──
            if (warehouseState) {
              const { warehouse, connector } = warehouseState;

              // Step 1/5: Generate SQL — or use the edited SQL if the user
              // supplied one via Edit-and-Rerun.
              emitProgress("generating_sql", 1);
              if (editedSql) {
                warehouseSQL = editedSql;
                logger.info("Warehouse query: using edited SQL (skipping LLM)", {
                  warehouseType: warehouse.config.type,
                  chars: editedSql.length,
                });
              } else {
                logger.info("Warehouse query: generating SQL", {
                  warehouseType: warehouse.config.type,
                  tableCount: warehouse.tableSchemas.length,
                  question,
                });
                try {
                  warehouseSQL = await generateSQL(
                    warehouse.tableSchemas,
                    question,
                    warehouse.config.type,
                    codeGenModel
                  );
                  logger.info("Warehouse query: SQL generated", { sql: warehouseSQL });
                } catch (err) {
                  const msg = err instanceof Error ? err.message : "SQL generation failed";
                  logger.error("Warehouse query: SQL generation failed", { error: msg });
                  throw new Error(`SQL generation failed: ${msg}`);
                }
              }

              if (closed) return;

              // Step 2/5: Execute SQL
              emitProgress("querying_warehouse", 2);
              logger.info("Warehouse query: executing SQL");

              let warehouseCsvContent: string;
              try {
                warehouseCsvContent = await connector.executeSQL(warehouseSQL);
                if (!warehouseCsvContent || warehouseCsvContent.trim() === "") {
                  throw new Error("SQL query returned no results");
                }
                const rowCount = warehouseCsvContent.split("\n").length - 2; // minus header and trailing newline
                logger.info("Warehouse query: SQL executed", { rows: rowCount });
              } catch (err) {
                const msg = err instanceof Error ? err.message : "SQL execution failed";
                logger.error("Warehouse query: SQL execution failed", {
                  error: msg,
                  sql: warehouseSQL,
                });
                throw new Error(`SQL execution failed: ${msg}\n\nGenerated SQL:\n${warehouseSQL}`);
              }

              // Parse CSV → extract schema → store as regular CSV
              const parsed = parseCSV(warehouseCsvContent);
              const newCsvId = randomUUID();
              const schema = extractSchema(parsed, newCsvId, `warehouse_query_result`);
              schema.source_type = "warehouse";
              schema.warehouse_type = warehouse.config.type;
              await storeCSV(newCsvId, warehouseCsvContent, schema);
              csvId = newCsvId;

              logger.info("Warehouse query: data stored as CSV", {
                csvId: newCsvId,
                columns: schema.columns.length,
              });

              // Emit the generated csvId so the client can use it for artifacts
              emit(
                JSON.stringify({
                  op: "add",
                  path: "/state/__warehouse_csv_id",
                  value: newCsvId,
                }) + "\n"
              );
            }

            // ── Load CSV (file upload or warehouse result) ──────────
            const stored = getStoredCSV(csvId!);
            if (!stored) {
              throw new Error("CSV not found or expired. Please re-upload.");
            }
            datasetLabel = stored.schema.filename;

            // Determine if this is a local file (bind-mount path)
            const isLocal = isLocalFile(csvId!);
            let localMountPath: string | undefined;

            if (isLocal) {
              // Local file: resolve the host path for bind-mount.
              // For local files, data is accessed via bind-mount, not content string.
              const hostPath = stored.localFolderPath || stored.localPath;
              if (!hostPath) {
                throw new Error("Local file path not found");
              }

              // Mtime check: invalidate if source file changed
              if (stored.localMtime) {
                try {
                  const { stat } = await import("node:fs/promises");
                  const { dirname } = await import("node:path");
                  const pathToCheck = stored.localFolderPath || stored.localPath!;
                  const info = await stat(pathToCheck);
                  if (info.mtimeMs !== stored.localMtime) {
                    throw new Error(
                      "Source file has been modified since schema was extracted. Please re-select the file."
                    );
                  }
                } catch (err) {
                  if (err instanceof Error && err.message.includes("re-select")) throw err;
                  // stat failed — file may have been removed
                  throw new Error(
                    "Source file is no longer accessible. Please re-select the file."
                  );
                }
              }

              // For single files, mount the parent directory
              // For folders, mount the folder itself
              if (stored.localFolderPath) {
                localMountPath = stored.localFolderPath;
              } else if (stored.localPath) {
                const { dirname } = await import("node:path");
                localMountPath = dirname(stored.localPath);
              }
            }

            const csvContent = isLocal ? "" : await getCSVContent(csvId!);
            if (!isLocal && !csvContent) {
              if (stored.schema.source_type === "warehouse") {
                throw new Error(
                  "This analysis was from a warehouse query. Please connect to the warehouse first, then ask your question."
                );
              }
              throw new Error("CSV content not found. Please re-upload your data.");
            }

            // Fetch GeoJSON sidecar if the upload was GeoJSON
            const geojsonContent = stored.schema.has_geojson
              ? await getGeoJSONContent(csvId!)
              : null;

            // Check for workbook manifest (multi-sheet analysis)
            const manifest = getWorkbookManifest(csvId!);
            let additionalFiles: AdditionalFile[] | undefined;
            let workbookContext: string | undefined;

            if (manifest) {
              additionalFiles = [];
              const sheetPaths = new Map<string, string>();
              for (const sheet of manifest.sheets) {
                if (sheet.csvId === csvId) {
                  sheetPaths.set(sheet.name, "/data/input.csv");
                  continue;
                }
                const content = await getCSVContent(sheet.csvId);
                if (content) {
                  const safeName = sanitizeSheetName(sheet.name);
                  const filePath = `/data/sheets/${safeName}.csv`;
                  additionalFiles.push({ path: filePath, content });
                  sheetPaths.set(sheet.name, filePath);
                }
              }
              workbookContext = buildWorkbookContext(manifest, schemaMode, sheetPaths);
            }

            // Map orchestrator stages to progress updates
            const stepOffset = isWarehouse ? 2 : 0;
            const onStage = (stage: string) => {
              if (stage === "generating_code") emitProgress("analyzing", stepOffset + 1);
              else if (stage === "executing") emitProgress("computing", stepOffset + 2);
              else if (stage === "retrying") emitProgress("retrying", stepOffset + 2);
            };

            // Build local file context for LLM prompt (tells it where to read data)
            let localFileContext: string | undefined;
            if (isLocal && localMountPath) {
              const { basename } = await import("node:path");
              if (stored.localFolderPath) {
                const hiveFlag = stored.isHivePartitioned ? ", hive_partitioning=true" : "";
                const readExpr = `read_parquet('/data/local/**/*.parquet'${hiveFlag})`;
                const isLarge = stored.schema.row_count > 1_000_000;
                localFileContext =
                  `This is a ${stored.isHivePartitioned ? "Hive-partitioned " : ""}folder of Parquet files mounted at /data/local/.\n` +
                  `Total rows: ${stored.schema.row_count.toLocaleString()}.\n` +
                  `FIRST, create a DuckDB view ONCE at the top of the script:\n` +
                  `  duckdb.sql("CREATE OR REPLACE VIEW data AS SELECT * FROM ${readExpr}")\n` +
                  `Then query the view. If the question targets a subset (e.g. specific users, date range), ` +
                  `materialize the filtered subset into a temp table FIRST for speed:\n` +
                  `  duckdb.sql("CREATE TEMP TABLE filtered AS SELECT * FROM data WHERE ...")\n` +
                  `  Then run all subsequent queries against 'filtered' instead of 'data'.\n` +
                  (stored.isHivePartitioned
                    ? `Partition columns (e.g. year, month) are automatically available as columns via Hive partitioning. USE them in WHERE clauses to filter efficiently.\n`
                    : "") +
                  (isLarge
                    ? `CRITICAL: This is a large dataset (${stored.schema.row_count.toLocaleString()} rows). You MUST use DuckDB SQL with WHERE, GROUP BY, or LIMIT to reduce data BEFORE calling .df(). NEVER SELECT * without a LIMIT or aggregation. Aggregate in SQL, convert only the small result to pandas. Keep total queries to 3 or fewer — combine aggregations into a single query when possible.\n`
                    : "") +
                  `Do NOT read from /data/input.csv — the data is in Parquet format at /data/local/.\n` +
                  `Do NOT use pd.read_parquet() — use duckdb.sql() for this dataset.`;
              } else if (stored.localPath) {
                const fname = basename(stored.localPath);
                const ext = fname.toLowerCase().split(".").pop();
                if (ext === "parquet") {
                  localFileContext =
                    `This is a Parquet file mounted at /data/local/${fname}.\n` +
                    `Read with: duckdb.sql("SELECT * FROM read_parquet('/data/local/${fname}')").df()\n` +
                    `Do NOT read from /data/input.csv — the data is in Parquet format at /data/local/${fname}.`;
                } else {
                  localFileContext =
                    `The data file is mounted at /data/local/${fname}.\n` +
                    `Read with: pd.read_csv("/data/local/${fname}")\n` +
                    `Do NOT read from /data/input.csv — the data is at /data/local/${fname}.`;
                }
              }
            }

            // Load prior conversation turns for follow-up context
            const priorTurns = csvId ? getConversationTurns(csvId) : [];

            // Run the code-gen + sandbox pipeline. When the caller supplied
            // pre-edited code via context.code (Edit-and-Rerun), skip the
            // code-gen step and execute the provided code directly.
            let pipelineResult;
            if (editedCode) {
              onStage("executing");
              pipelineResult = await runPipelineWithCode(editedCode, csvContent || "", question, {
                runtime: sandboxRuntime,
                geojsonContent,
                additionalFiles,
                csvId,
                localMountPath,
              });
            } else {
              pipelineResult = await runPipeline(
                stored.schema,
                csvContent || "",
                question,
                onStage,
                schemaMode,
                codeGenModel,
                sandboxRuntime,
                geojsonContent,
                additionalFiles,
                workbookContext,
                localMountPath,
                localFileContext,
                priorTurns.length > 0 ? priorTurns : undefined
              );
            }

            if (closed) return;

            // Cache the generated code for save functionality
            cacheGeneratedCode(csvId!, pipelineResult.generatedCode, question);

            // Cache artifacts for the artifacts viewer
            const { executionResult } = pipelineResult;
            const cachedArtifactData = {
              code: pipelineResult.generatedCode,
              question,
              results: executionResult.results as Record<string, unknown>,
              chart_data: executionResult.chart_data as Record<string, unknown>,
              datasets: (executionResult.datasets ?? {}) as Record<
                string,
                Record<string, unknown>[]
              >,
              execution_ms: executionResult.execution_ms ?? 0,
              sql: warehouseSQL,
            };
            cacheArtifacts(csvId!, cachedArtifactData);

            // Append this turn to the conversation cache for follow-up context.
            // specSummary is empty here because the UI spec hasn't been streamed yet —
            // it will be populated by the client via the update endpoint after rendering.
            // The analysisSummary (resultKeys + chartDataShapes) is the critical part
            // that tells the code gen LLM what was computed.
            if (csvId) {
              const turn = buildTurnFromArtifacts(question, cachedArtifactData, {});
              appendConversationTurn(csvId, turn);
            }
            // Compose + stream the dashboard. Shared with the Investigate lookup
            // fast-path (see lib/pipeline/dashboard-compose.ts) so both produce an
            // identical single-shot dashboard from one execution result.
            await composeAndStreamDashboard({
              executionResult,
              opts: {
                question,
                schema: stored.schema,
                schemaMode,
                purpose,
                priorTurns,
                drillDownContext,
                workbookContext,
              },
              uiComposeModel,
              emit,
              isClosed: () => closed,
              onComposing: () => emitProgress("composing", stepOffset + 3),
            });
          } catch (pipelineErr) {
            // Pipeline or LLM setup error — emit error annotation into the stream
            if (!closed) {
              const errMsg =
                pipelineErr instanceof Error ? pipelineErr.message : String(pipelineErr);
              logger.error("Pipeline error", { error: errMsg });
              emit(
                JSON.stringify({
                  op: "add",
                  path: "/root",
                  value: "error",
                }) + "\n"
              );
              emit(
                JSON.stringify({
                  op: "add",
                  path: "/elements/error",
                  value: {
                    type: "Annotation",
                    props: {
                      icon: "alert",
                      title: "Analysis Error",
                      content: errMsg.includes("too long")
                        ? "The analysis data is too large for the AI to process. Try a more specific question."
                        : errMsg,
                      severity: "error",
                    },
                    children: [],
                  },
                }) + "\n"
              );
            }
          }

          // ── Cost tracking: sum all LLM calls, surface live + persist a row ──
          try {
            const acc = getCostAccumulator();
            if (acc) {
              const cost = computeCost(acc);
              emit(JSON.stringify({ op: "add", path: "/state/__cost", value: cost }) + "\n");
              const now = new Date();
              await appendCostRow({
                timestamp: now.toISOString(),
                date: now.toISOString().slice(0, 10),
                dataset: datasetLabel,
                question,
                mode: "ask",
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
            logger.warn("Cost logging failed", {
              error: costErr instanceof Error ? costErr.message : String(costErr),
            });
          }
        });

        clearInterval(keepalive);
        if (!closed) {
          try {
            controller.close();
          } catch {
            // Already closed
          }
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Transfer-Encoding": "chunked",
      },
    });
  } catch (err) {
    logger.error("Query error", { error: err instanceof Error ? err.message : String(err) });
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
