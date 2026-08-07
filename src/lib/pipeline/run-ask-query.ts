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
import {
  findingsMode,
  mergeDeclarations,
  validateFindings,
  lintDerivations,
  lintMissingLinkage,
  lintGranularityConflict,
  lintCompletenessConflict,
  lintTrendContract,
  lintCheckGating,
  lintNoChecksDeclared,
  lintMethodMismatch,
  lintNullAncestry,
} from "@/lib/findings";
import { saveConventions } from "@/lib/learning/conventions";
import { lintRangeFabrication } from "@/lib/findings";
import type { FindingEntry, FindingIssue, FindingsManifest } from "@/lib/contracts/findings";
import { diagEvent } from "@/lib/diagnostics/run-diagnostics";
import { WAREHOUSE_SCAN_ROW_BUDGET } from "@/lib/constants";
import type { SandboxRuntimeId } from "@/lib/constants";
import type { SchemaMode } from "@/lib/contracts/data-schema";
import type { AnalysisRequestContext, DrillDownContext } from "@/lib/contracts/analysis-request";
import {
  getConversationTurns,
  appendConversationTurn,
  buildTurnFromArtifacts,
  aliasConversationKey,
} from "@/lib/pipeline/conversation-cache";
import { composeAndStreamDashboard } from "@/lib/pipeline/dashboard-compose";
import type { PatchStream } from "@/lib/pipeline/patch-stream";
import { logger, serializeError } from "@/lib/logger";
import type { ResolvedAnalysisSource } from "@/lib/pipeline/validate-request";
import { runWarehouseQuery } from "@/lib/warehouse/run-query";
import { storeWarehouseResult } from "@/lib/warehouse/materialize-result";

/**
 * The Ask analysis, decoupled from HTTP (modularization M3-3a, spec WS5).
 *
 * This is the /api/query route body, lifted VERBATIM: warehouse SQL →
 * materialize → load source → code-gen/exec pipeline → compose+stream, with
 * the cost/diagnostics epilogue in a finally. The route (or any harness —
 * the WS8 CLI) owns transport: body parsing, validation 4xx's, and wrapping
 * a PatchStream around emit/isClosed.
 *
 * `runState.csvId` is shared MUTABLE state with the caller's disconnect
 * handler: a warehouse run only learns its materialized csvId mid-stream,
 * and persistHistoryOnDisconnect must see the updated id.
 */

export interface AskRunState {
  csvId: string | undefined;
  question: string;
}

export interface RunAskQueryArgs {
  context: AnalysisRequestContext;
  question: string;
  /**
   * Discriminated source from validate-request: a stored CSV (upload/local/
   * remote ref) or a live warehouse connection. Narrowing `kind` once here
   * replaced the csvId!/warehouseState! assertions this file carried.
   */
  source: ResolvedAnalysisSource;
  codeGenModel: string;
  uiComposeModel: string;
  sandboxRuntime: SandboxRuntimeId;
  runState: AskRunState;
  stream: PatchStream;
}

export async function runAskQuery(args: RunAskQueryArgs): Promise<void> {
  const {
    context,
    question,
    source,
    codeGenModel,
    uiComposeModel,
    sandboxRuntime,
    runState,
    stream,
  } = args;

  const drillDownContext: DrillDownContext | undefined = context.drill_down_context;
  const schemaMode: SchemaMode = context.schema_mode === "sample" ? "sample" : "metadata";
  const purpose: string = context.purpose ?? "dashboard";
  /**
   * Optional pre-generated code. When provided, skip code-gen (step 1) and
   * run only the sandbox-execute → UI-compose path. Used by the
   * Edit-and-Rerun feature to rebuild the dashboard from edited code.
   */
  const editedCode: string | undefined =
    typeof context.code === "string" && context.code.trim().length > 0 ? context.code : undefined;

  /**
   * Optional pre-edited SQL (warehouse sources only). When provided, skip
   * NL-to-SQL generation and use the edited SQL directly. The result CSV's
   * schema is re-extracted, so the downstream Python code-gen runs against
   * the new shape. Combined with `editedCode`, both LLM steps are skipped.
   */
  const editedSql: string | undefined =
    typeof context.sql === "string" && context.sql.trim().length > 0 ? context.sql : undefined;

  const isWarehouse = source.kind === "warehouse";
  const totalSteps = isWarehouse ? 5 : 3;

  // Conversation turns must key by a STABLE id. Files: csvId (constant per
  // upload). Warehouse: warehouseId — each warehouse question materializes a
  // NEW snapshot csvId, so keying those turns by csvId stored them under ids
  // that were never read again (warehouse follow-ups silently had no context).
  const conversationKey = source.kind === "warehouse" ? source.warehouseId : source.csvId;

  let warehouseSQL: string | undefined;
  // Set when a large warehouse pull was materialized to Parquet: the host
  // file to copy into the sandbox and the DuckDB read instructions.
  let warehouseParquetFile: string | undefined;
  let warehouseParquetContext: string | undefined;
  let datasetLabel = runState.csvId ?? conversationKey;

  const emit = stream.emit;
  const closed = () => stream.isClosed();
  const emitProgress = (stage: string, step: number) =>
    stream.emitProgress(stage, step, totalSteps);
  // Make this run discoverable by a reconnecting client (run-stream-hub).
  // csvId may still be null here for a warehouse run — updated once its
  // result is materialized (below).
  stream.setMeta({ csvId: runState.csvId ?? undefined, question });

  await runWithCostTracking(() =>
    runWithDiagnostics(async () => {
      try {
        // Follow-up context — read once, BEFORE SQL generation, so a
        // warehouse follow-up's SQL inherits the prior turns' questions
        // and SQL (population continuity), not just the Python stage.
        const priorTurns = getConversationTurns(conversationKey);

        // The analysis' data id: the csv source directly, or the snapshot a
        // warehouse run materializes below. Guaranteed a string past this
        // block — downstream stages previously asserted `csvId!` per read.
        let csvId: string;

        // ── Warehouse path: generate SQL → execute → store as CSV ──
        if (source.kind === "warehouse") {
          const { warehouse, connector } = source.warehouseState;

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
              throw new Error(`SQL execution failed: ${msg}\n\nGenerated SQL:\n${warehouseSQL}`);
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
          runState.csvId = csvId;
          warehouseParquetFile = storedResult.parquetFile;
          warehouseParquetContext = storedResult.parquetContext;
          // Warehouse csvId now known — make the run discoverable by it,
          // and alias this snapshot onto the stable conversation key so
          // csvId-keyed consumers (history persist, suggest) find the
          // warehouse conversation.
          stream.setMeta({ csvId });
          aliasConversationKey(csvId, conversationKey);
        } else {
          csvId = source.csvId;
        }

        // ── Load CSV (file upload or warehouse result) ──────────
        const stored = getStoredCSV(csvId);
        if (!stored) {
          throw new Error("CSV not found or expired. Please re-upload.");
        }
        datasetLabel = stored.schema.filename;

        // Determine if this is a local file (bind-mount path) or a remote
        // cloud Parquet source (DuckDB reads the URL directly, no mount).
        const isLocal = isLocalFile(csvId);
        const isRemote = isRemoteFile(csvId);
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
              const info = await stat(hostPath);
              if (info.mtimeMs !== stored.localMtime) {
                throw new Error(
                  "Source file has been modified since schema was extracted. Please re-select the file."
                );
              }
            } catch (err) {
              if (err instanceof Error && err.message.includes("re-select")) throw err;
              // stat failed — file may have been removed
              throw new Error("Source file is no longer accessible. Please re-select the file.");
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
          isLocal || isRemote || warehouseParquetFile ? "" : await getCSVContent(csvId);
        if (!isLocal && !isRemote && !warehouseParquetFile && !csvContent) {
          if (stored.schema.source_type === "warehouse") {
            throw new Error(
              "This analysis was from a warehouse query. Please connect to the warehouse first, then ask your question."
            );
          }
          throw new Error("CSV content not found. Please re-upload your data.");
        }

        // Fetch GeoJSON sidecar if the upload was GeoJSON
        const geojsonContent = stored.schema.has_geojson ? await getGeoJSONContent(csvId) : null;

        // Check for workbook manifest (multi-sheet analysis)
        const manifest = getWorkbookManifest(csvId);
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
        cacheGeneratedCode(csvId, pipelineResult.generatedCode, question);

        // Cache artifacts for the artifacts viewer
        const { executionResult } = pipelineResult;

        // ── Declared findings (spec §3/§8): merge → validate → lint. Runs
        // in shadow AND on (the rollout needs real manifests to measure);
        // "off" skips entirely. Shadow ships to NO consumer — the manifest
        // lands only in the artifacts record and diagnostics.
        const mode = findingsMode();
        let findingsManifest: FindingsManifest | undefined;
        let findingIssues: FindingIssue[] = [];
        if (mode !== "off" && Array.isArray(executionResult.findings)) {
          const merged = mergeDeclarations(
            executionResult.findings.filter(
              (f): f is FindingEntry =>
                !!f && typeof f === "object" && !("__dropped__" in (f as object))
            )
          );
          const referenceNames = [
            ...stored.schema.columns.map((c) => c.name),
            ...Object.keys(executionResult.results ?? {}),
            ...merged.map((m) => m.name),
          ];
          const validated = validateFindings(merged, { referenceNames });
          findingsManifest = validated.manifest;
          if (executionResult.runtime_fallback) {
            logger.error("Sandbox runtime fell back to stubs — findings degraded", {
              error: executionResult.runtime_fallback,
            });
          }
          findingIssues = [
            ...(executionResult.runtime_fallback
              ? [
                  {
                    kind: "runtime_fallback",
                    detail: `sandbox runtime failed to import (${executionResult.runtime_fallback}) — statistical helpers were stubs and null findings are a pipeline failure, not a data property`,
                  },
                ]
              : []),
            ...validated.issues,
            ...lintDerivations(validated.manifest.findings),
            ...lintMissingLinkage(validated.manifest.findings),
            ...lintGranularityConflict(validated.manifest.findings),
            ...lintCheckGating(validated.manifest.findings),
            ...lintNoChecksDeclared(validated.manifest.findings),
            ...lintMethodMismatch(validated.manifest.findings),
            ...lintNullAncestry(validated.manifest.findings),
            ...lintTrendContract(validated.manifest.findings),
            ...lintRangeFabrication(validated.manifest.findings, executionResult.data_completeness),
            ...lintCompletenessConflict(
              validated.manifest.findings,
              executionResult.data_completeness
            ),
          ];
          // Persist this run's checks as the dataset's settled conventions
          // (drift fix): the next run on the same column shape receives them.
          saveConventions(
            stored.schema.columns.map((c) => c.name),
            validated.manifest.findings,
            question
          );
          diagEvent("findings", {
            mode,
            declared: executionResult.findings.length,
            kept: findingsManifest.findings.length,
            dropped: validated.droppedCount,
            issues: findingIssues.map((i) => i.kind),
            compliance: findingsManifest.findings.length > 0,
          });
        } else if (mode !== "off") {
          // Zero declarations: advisory only, NEVER a retry (spec §8 — a
          // retry teaches speculative declaration).
          diagEvent("findings", { mode, declared: 0, kept: 0, dropped: 0, compliance: false });
        }

        const cachedArtifactData = {
          code: pipelineResult.generatedCode,
          question,
          results: executionResult.results as Record<string, unknown>,
          chart_data: executionResult.chart_data as Record<string, unknown>,
          datasets: (executionResult.datasets ?? {}) as Record<string, Record<string, unknown>[]>,
          execution_ms: executionResult.execution_ms ?? 0,
          sql: warehouseSQL,
          ...(findingsManifest ? { findings: findingsManifest } : {}),
        };
        cacheArtifacts(csvId, cachedArtifactData);

        // Append this turn to the conversation cache for follow-up context.
        // specSummary is empty here because the UI spec hasn't been streamed yet —
        // it will be populated by the client via the update endpoint after rendering.
        // The analysisSummary (resultKeys + chartDataShapes) is the critical part
        // that tells the code gen LLM what was computed.
        appendConversationTurn(
          conversationKey,
          buildTurnFromArtifacts(question, cachedArtifactData, {})
        );
        // Compose + stream the dashboard. Shared with the Investigate lookup
        // fast-path (see lib/pipeline/dashboard-compose.ts) so both produce an
        // identical single-shot dashboard from one execution result.
        await composeAndStreamDashboard({
          executionResult,
          opts: {
            // Consumers receive the manifest ONLY in mode "on" (spec §8).
            ...(mode === "on" && findingsManifest
              ? { findings: { manifest: findingsManifest, issues: findingIssues } }
              : {}),
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
        const errMsg = pipelineErr instanceof Error ? pipelineErr.message : String(pipelineErr);
        // Unconditional: after a disconnect the server log is the only
        // record of the failure — gating it on the socket hid every error
        // that happened once the client was gone.
        logger.error("Pipeline error", serializeError(pipelineErr));
        // Typed error channel (`/state/__error`, contracts/stream-state) —
        // the harness contract Investigate already honors; the CLI and MCP
        // read the real message here. Emitted regardless of closed(): the
        // hub buffer keeps it for a reconnecting client and the disconnect
        // history-save.
        emit(
          JSON.stringify({
            op: "add",
            path: "/state/__error",
            value: errMsg,
          }) + "\n"
        );
        // UI affordance (additive to the channel above) — only worth
        // streaming while a client is attached.
        if (!closed()) {
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
}
