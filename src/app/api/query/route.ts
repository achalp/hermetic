import {
  getStoredCSV,
  getCSVContent,
  getGeoJSONContent,
  getWorkbookManifest,
  isLocalFile,
  isRemoteFile,
} from "@/lib/csv/storage";
import { runPipeline, runPipelineWithCode } from "@/lib/pipeline/orchestrator";
import { resolveLocalSource, resolveRemoteSource } from "@/lib/parquet/duckdb-source";
import { runWithCostTracking } from "@/lib/cost/accumulator";
import { emitCostEpilogue } from "@/lib/cost/epilogue";
import { runWithDiagnostics } from "@/lib/diagnostics/run-diagnostics";
import { buildWorkbookContext, sanitizeSheetName } from "@/lib/llm/prompts";
import type { AdditionalFile } from "@/lib/sandbox";
import { cacheGeneratedCode } from "@/lib/pipeline/code-cache";
import { cacheArtifacts } from "@/lib/pipeline/artifacts-cache";
import { WAREHOUSE_SCAN_ROW_BUDGET } from "@/lib/constants";
import type { SchemaMode } from "@/lib/contracts/data-schema";
import {
  getConversationTurns,
  appendConversationTurn,
  buildTurnFromArtifacts,
  aliasConversationKey,
} from "@/lib/pipeline/conversation-cache";
import { composeAndStreamDashboard, type DrillDownContext } from "@/lib/pipeline/dashboard-compose";
import { patchStreamResponse } from "@/lib/pipeline/patch-stream";
import { logger, serializeError } from "@/lib/logger";
import { apiError } from "@/lib/api-error";
import { getActiveProvider, providerCapabilities } from "@/lib/llm/client";
import {
  validateQueryIds,
  resolveQuerySources,
  type QueryRequestContext,
} from "@/lib/pipeline/validate-request";
import { readJsonBody } from "@/lib/api-schemas";
import { runWarehouseQuery } from "@/lib/warehouse/run-query";
import { storeWarehouseResult } from "@/lib/warehouse/materialize-result";
import { persistHistoryOnDisconnect } from "@/lib/history/persist-on-disconnect";

export const maxDuration = 1260; // 21 min — matches the large-data sandbox budget (remote billion-row scans)

export async function POST(request: Request) {
  // Aborted duplicate requests truncate the body — a 400, not a logged 500.
  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  try {
    const body = read.body as {
      prompt?: string;
      context?: QueryRequestContext & {
        drill_down_context?: DrillDownContext;
        schema_mode?: string;
        purpose?: string;
        code?: string;
        sql?: string;
      };
    };
    const { prompt, context } = body;

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
    if (!ids.ok) return ids.response;
    const { warehouseId, question } = ids;
    let csvId = ids.csvId;

    const sources = resolveQuerySources(ids, context ?? {}, { skipModelValidation });
    if (!sources.ok) return sources.response;
    const { warehouseState, codeGenModel, uiComposeModel, sandboxRuntime } = sources;

    // Stream immediately — emit progress patches as the pipeline runs, then
    // stream LLM output. The scaffold (emit/keepalive/progress semantics/
    // headers/abort diagnostics) is shared with Investigate — see
    // lib/pipeline/patch-stream.ts.
    const isWarehouse = !!warehouseState;
    const totalSteps = isWarehouse ? 5 : 3;

    // Conversation turns must key by a STABLE id. Files: csvId (constant per
    // upload). Warehouse: warehouseId — each warehouse question materializes a
    // NEW snapshot csvId, so keying those turns by csvId stored them under ids
    // that were never read again (warehouse follow-ups silently had no context).
    const conversationKey = isWarehouse ? warehouseId : csvId;

    let warehouseSQL: string | undefined;
    // Set when a large warehouse pull was materialized to Parquet: the host
    // file to copy into the sandbox and the DuckDB read instructions.
    let warehouseParquetFile: string | undefined;
    let warehouseParquetContext: string | undefined;
    let datasetLabel = csvId ?? warehouseId ?? "dataset";

    return patchStreamResponse(
      "/api/query",
      request,
      async (stream) => {
        const emit = stream.emit;
        const closed = () => stream.isClosed();
        const emitProgress = (stage: string, step: number) =>
          stream.emitProgress(stage, step, totalSteps);
        // Make this run discoverable by a reconnecting client (run-stream-hub).
        // csvId may still be null here for a warehouse run — updated once its
        // result is materialized (below).
        stream.setMeta({ csvId: csvId ?? undefined, question });

        await runWithCostTracking(() =>
          runWithDiagnostics(async () => {
            try {
              // Follow-up context — read once, BEFORE SQL generation, so a
              // warehouse follow-up's SQL inherits the prior turns' questions
              // and SQL (population continuity), not just the Python stage.
              const priorTurns = conversationKey ? getConversationTurns(conversationKey) : [];

              // ── Warehouse path: generate SQL → execute → store as CSV ──
              if (warehouseState) {
                const { warehouse, connector } = warehouseState;

                // Step 1/5 + 2/5: Generate + execute SQL — or use the edited SQL
                // if the user supplied one via Edit-and-Rerun.
                emitProgress("generating_sql", 1);
                let warehouseCsvContent: string;

                if (editedSql) {
                  // User-supplied SQL — run as-is, no generation/repair.
                  warehouseSQL = editedSql;
                  logger.info("Warehouse query: using edited SQL (skipping LLM)", {
                    warehouseType: warehouse.config.type,
                    chars: editedSql.length,
                  });
                  if (closed()) return;
                  emitProgress("querying_warehouse", 2);
                  try {
                    warehouseCsvContent = await connector.executeSQL(warehouseSQL);
                    if (!warehouseCsvContent || warehouseCsvContent.trim() === "") {
                      throw new Error("SQL query returned no results");
                    }
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : "SQL execution failed";
                    logger.error("Warehouse query: SQL execution failed", {
                      error: msg,
                      sql: warehouseSQL,
                    });
                    throw new Error(
                      `SQL execution failed: ${msg}\n\nGenerated SQL:\n${warehouseSQL}`
                    );
                  }
                } else {
                  // Shared warehouse hardening: bound the scan from engine
                  // metadata, then generate → execute → self-heal. Same path
                  // Investigate uses, so any future SQL-reliability fix applies to
                  // both. (Previously Ask was one-shot and hard-failed on a
                  // too-wide scan.)
                  logger.info("Warehouse query: generating SQL", {
                    warehouseType: warehouse.config.type,
                    tableCount: warehouse.tableSchemas.length,
                    question,
                  });
                  try {
                    const outcome = await runWarehouseQuery({
                      tables: warehouse.tableSchemas,
                      connector,
                      warehouseType: warehouse.config.type,
                      question,
                      model: codeGenModel,
                      scanRowBudget: WAREHOUSE_SCAN_ROW_BUDGET,
                      priorTurns: priorTurns.length > 0 ? priorTurns : undefined,
                      onAttempt: (attempt, phase) => {
                        if (closed()) return;
                        if (phase === "repairing") {
                          logger.info("Warehouse query: repairing SQL", { attempt });
                          emitProgress("generating_sql", 1);
                        } else if (phase === "executing") {
                          emitProgress("querying_warehouse", 2);
                        }
                      },
                    });
                    warehouseSQL = outcome.sql;
                    warehouseCsvContent = outcome.csv;
                    logger.info("Warehouse query: SQL generated + executed", { sql: warehouseSQL });
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : "SQL failed";
                    logger.error("Warehouse query: SQL failed after repair attempts", {
                      error: msg,
                      sql: warehouseSQL,
                    });
                    throw new Error(
                      `SQL execution failed: ${msg}${warehouseSQL ? `\n\nGenerated SQL:\n${warehouseSQL}` : ""}`
                    );
                  }
                }

                if (closed()) return;

                // Store the result (Parquet for large pulls, CSV otherwise) via
                // the SHARED module — lib/warehouse/materialize-result.ts. Ask
                // previously always parsed through Node; it now gets the same
                // Parquet path Investigate uses for million-row results.
                const storedResult = await storeWarehouseResult({
                  csvContent: warehouseCsvContent,
                  warehouseType: warehouse.config.type,
                  sandboxRuntime,
                  emit,
                });
                csvId = storedResult.csvId;
                warehouseParquetFile = storedResult.parquetFile;
                warehouseParquetContext = storedResult.parquetContext;
                // Warehouse csvId now known — make the run discoverable by it,
                // and alias this snapshot onto the stable conversation key so
                // csvId-keyed consumers (history persist, suggest) find the
                // warehouse conversation.
                stream.setMeta({ csvId });
                if (conversationKey) aliasConversationKey(csvId, conversationKey);
              }

              // ── Load CSV (file upload or warehouse result) ──────────
              const stored = getStoredCSV(csvId!);
              if (!stored) {
                throw new Error("CSV not found or expired. Please re-upload.");
              }
              datasetLabel = stored.schema.filename;

              // Determine if this is a local file (bind-mount path) or a remote
              // cloud Parquet source (DuckDB reads the URL directly, no mount).
              const isLocal = isLocalFile(csvId!);
              const isRemote = isRemoteFile(csvId!);
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

                // Mount path + code-gen "Data Location" context come from the
                // shared resolver (see lib/parquet/duckdb-source).
                ({ localMountPath } = resolveLocalSource(stored));
              }

              // In Parquet mode (local mount, materialized warehouse, or remote
              // URL) the analysis reads Parquet directly — never load the
              // (large) CSV into memory.
              const csvContent =
                isLocal || isRemote || warehouseParquetFile ? "" : await getCSVContent(csvId!);
              if (!isLocal && !isRemote && !warehouseParquetFile && !csvContent) {
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

              // Build local file context for LLM prompt (tells it where to read
              // data). A materialized warehouse pull was docker-cp'd to
              // /data/input.parquet (no mount) — same resolvers as Investigate.
              const { localFileContext } = warehouseParquetFile
                ? { localFileContext: warehouseParquetContext }
                : isLocal
                  ? resolveLocalSource(stored)
                  : isRemote
                    ? resolveRemoteSource(
                        stored.remoteParquetUrl!,
                        stored.schema.row_count,
                        stored.isHivePartitioned,
                        stored.remoteCreds
                      )
                    : {};

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
                  inputParquetPath: warehouseParquetFile,
                });
              } else {
                pipelineResult = await runPipeline(stored.schema, csvContent || "", question, {
                  onStage,
                  mode: schemaMode,
                  model: codeGenModel,
                  runtime: sandboxRuntime,
                  geojsonContent,
                  additionalFiles,
                  workbookContext,
                  localMountPath,
                  localFileContext,
                  priorTurns: priorTurns.length > 0 ? priorTurns : undefined,
                  inputParquetPath: warehouseParquetFile,
                  purpose,
                });
              }

              // NOTE: deliberately NO `if (closed()) return` here. The
              // execution is the expensive, already-paid part — a client
              // disconnect during it (the longest phase) must not discard the
              // result. Compose runs to completion into the dead socket
              // (emit() no-ops), the patches accumulate in emittedLines, and
              // persistHistoryOnDisconnect saves the assembled spec so the
              // user finds the answer in History after reconnecting. An early
              // return here was exactly how a 13-min remote scan finished
              // successfully 2 minutes after a "network error" and left
              // nothing behind (run 16ac725e, 2026-07-09).

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
              if (conversationKey) {
                const turn = buildTurnFromArtifacts(question, cachedArtifactData, {});
                appendConversationTurn(conversationKey, turn);
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
                isClosed: stream.isClosed,
                onComposing: () => emitProgress("composing", stepOffset + 3),
              });
            } catch (pipelineErr) {
              // Pipeline or LLM setup error — emit error annotation into the stream
              if (!closed()) {
                const errMsg =
                  pipelineErr instanceof Error ? pipelineErr.message : String(pipelineErr);
                logger.error("Pipeline error", serializeError(pipelineErr));
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
            } finally {
              // ── Cost/diagnostics epilogue: shared with Investigate
              // (lib/cost/epilogue.ts) — surfaces __cost live, persists the
              // cost row (now with the per-phase breakdown), writes run
              // diagnostics. In a finally so every exit path is accounted.
              await emitCostEpilogue({ emit, datasetLabel, question, mode: "ask", purpose });
            }
          })
        );
      },
      // Client disconnected mid-run → persist history server-side (shared with
      // Investigate — see lib/history/persist-on-disconnect.ts).
      (stream) => persistHistoryOnDisconnect(stream, csvId, question)
    );
  } catch (err) {
    return apiError("/api/query", err, String(err));
  }
}
