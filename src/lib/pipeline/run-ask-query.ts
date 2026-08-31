import {
  getStoredCSV,
  getCSVContent,
  getGeoJSONContent,
  getWorkbookManifest,
  isLocalFile,
  isRemoteFile,
} from "@/lib/csv/storage";
import { getRunSignal } from "@/lib/pipeline/run-control";
import { runPipeline, runPipelineWithCode } from "@/lib/pipeline/orchestrator";
import {
  resolveLocalSource,
  isLocalParquetSource,
  resolveRemoteSource,
  resolveWasmRemoteSource,
  remoteAuthSubst as remoteAuthSubstFor,
} from "@/lib/parquet/duckdb-source";
import {
  materializeRemoteCsvForWasm,
  enumerateRemoteParquetFiles,
} from "@/lib/sandbox/remote-fetch";
import { materializeLocalParquetCsvForWasm } from "@/lib/parquet/host-materialize";
import {
  resolveManifestQuestion,
  buildManifestQuestionContext,
  buildManifestWasmAliases,
} from "@/lib/manifest/question-context";
import {
  buildHiveAliases,
  buildHiveReadExpr,
  budgetForFile,
  encodeS3Key,
} from "@/lib/sandbox/wasm/remote-hive";
import { getRangeRegistry, getWarmCache } from "@/lib/sandbox/wasm/range-singleton";
import { prefetchFooters } from "@/lib/sandbox/wasm/footer-prefetch";
import { deriveAllowedEgressHosts } from "@/lib/sandbox/egress";
import { hermeticPaths } from "@/lib/paths";
import { unlink } from "node:fs/promises";
import { runWithCostTracking } from "@/lib/cost/accumulator";
import { emitCostEpilogue } from "@/lib/cost/epilogue";
import { runWithDiagnostics } from "@/lib/diagnostics/run-diagnostics";
import { buildWorkbookContext, sanitizeSheetName } from "@/lib/llm/prompts";
import { isContextLengthError } from "@/lib/llm/errors";
import type { AdditionalFile } from "@/lib/sandbox";
import { cacheGeneratedCode } from "@/lib/pipeline/code-cache";
import { cacheArtifacts, getCachedArtifacts } from "@/lib/pipeline/artifacts-cache";
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
  surfaceUndeclaredFailedChecks,
  surfaceUndeclaredScreens,
  dedupeSurfacedTwins,
  lintMislabeledAverage,
  lintOutlierDetectorDisagreement,
  lintMethodMismatch,
  lintNullAncestry,
  lintDefinitionContradicted,
  lintChartConsistency,
  lintUndeclaredScreen,
  lintScreenScopeMismatch,
  lintUnscreenedSuperlative,
  lintWellAttestedScreened,
  lintThinSuperlative,
  lintNullZeroMirror,
  lintRegimePolicy,
  lintUnaggregatedRollup,
  lintSeriesConsumption,
  lintResultsProvenance,
  lintOrphanDecisionResult,
  lintUnweightedCountedTrend,
  lintMixedUnitGroupSeries,
} from "@/lib/findings";
import { normalizeHeadlineStats } from "@/lib/findings/headline-plan";
import { parseProduct, productRolesIndex } from "@/lib/product";
import { vetoExemplarByRunId } from "@/lib/learning/exemplars";
import { getRunId } from "@/lib/run-context";
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
import { logger, serializeError, errMessage } from "@/lib/logger";
import { rehydrateRemoteSourceFromHistory } from "@/lib/history/rehydrate-source";
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
                signal: getRunSignal(),
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
        let stored = getStoredCSV(csvId);
        if (!stored && context.history_id) {
          // Cold miss: the in-memory ref is gone (e.g. a server restart), but a
          // CLOUD source has a durable home — the history record's URL. Rehydrate
          // from it and read the bucket directly, rather than forcing a re-upload
          // for data that never left the cloud. Uploaded/local sources have no
          // URL to point back at, so this no-ops and the honest error stands.
          if (await rehydrateRemoteSourceFromHistory(csvId, context.history_id)) {
            stored = getStoredCSV(csvId);
            logger.info("Recovered expired source from history for follow-up", {
              csvId,
              historyId: context.history_id,
            });
          }
        }
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
          // shared resolver (see lib/parquet/duckdb-source) — but ONLY where a
          // bind-mount exists. The wasm worker has no filesystem, so its local
          // data is DELIVERED (below) rather than mounted; setting a mount path
          // here would trip the capability gate on a source we can actually run
          // (build log D25).
          if (sandboxRuntime !== "wasm") {
            ({ localMountPath } = resolveLocalSource(stored));
          }
        }

        // In Parquet mode (local mount, materialized warehouse, or remote
        // URL) the analysis reads Parquet directly — never load the
        // (large) CSV into memory.
        // On wasm a local CSV has no mount to read from, so it takes the ordinary
        // content path (the worker's proven `/data/input.csv`); a local PARQUET is
        // converted host-side instead, further down.
        const wasmLocalCsv = sandboxRuntime === "wasm" && isLocal && !isLocalParquetSource(stored);
        const csvContent =
          (isLocal && !wasmLocalCsv) || isRemote || warehouseParquetFile
            ? ""
            : await getCSVContent(csvId);
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
          // Read all sibling sheets in PARALLEL (perf P12 — the sequential loop
          // paid N serial disk reads before code-gen). Order is preserved by
          // mapping over the manifest, so sheetPaths/additionalFiles are
          // byte-identical to the sequential version.
          const loaded = await Promise.all(
            manifest.sheets.map(async (sheet) => ({
              sheet,
              content: sheet.csvId === csvId ? null : await getCSVContent(sheet.csvId),
            }))
          );
          for (const { sheet, content } of loaded) {
            if (sheet.csvId === csvId) {
              sheetPaths.set(sheet.name, "/data/input.csv");
              continue;
            }
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

        // WASM + remote (build log D13): the webview worker has NO network, so a
        // remote source is materialized HOST-SIDE through the Rust egress core and
        // converted parquet→CSV; the worker then reads a local /data/input.csv on its
        // proven pandas path (so the generated code does no remote IO). Delivered to
        // the worker below via wasmFetchInputs; cleaned up after the run.
        let wasmCsvPath: string | undefined;
        // A FOLDER / hive source on the WASM tier (build log D21): enumerate the
        // prefix host-side, mint one range token per file, and let DuckDB in the
        // worker range-read them. One token per file (never a prefix-scoped token)
        // keeps the D20 invariant intact — the worker picks offsets, not destinations.
        let wasmDuckDbAliases: { name: string; url: string }[] | undefined;
        let wasmHiveReadExpr: string | undefined;
        const wasmMultiFile =
          sandboxRuntime === "wasm" &&
          isRemote &&
          !context.manifest && // manifest questions build per-entity aliases below (D40)
          Boolean(stored.isHivePartitioned || stored.remoteParquetUrl?.includes("*"));

        if (wasmMultiFile) {
          const { host, objects } = await enumerateRemoteParquetFiles(stored, {
            signal: getRunSignal(),
          });
          const aliases = buildHiveAliases(objects, host, (url: string, sizeBytes: number) =>
            getRangeRegistry().register({
              url,
              allowlist: deriveAllowedEgressHosts(stored.remoteParquetUrl!, stored.remoteCreds),
              ...(getRunId() ? { runId: getRunId()! } : {}),
              budgetBytes: budgetForFile(sizeBytes),
            })
          );
          wasmDuckDbAliases = aliases;
          wasmHiveReadExpr = buildHiveReadExpr(aliases, Boolean(stored.isHivePartitioned));
          // Fire-and-forget: warm every file's tail IN PARALLEL while the worker is
          // still booting Pyodide. DuckDB's sync-XHR footer reads are sequential, so
          // this is what turns ~1500 serial round trips into cache hits. Deliberately
          // NOT awaited and never fatal — the worker can always fetch on demand.
          const egressHosts = deriveAllowedEgressHosts(
            stored.remoteParquetUrl!,
            stored.remoteCreds
          );
          void prefetchFooters(
            objects.map((o) => ({
              url: `https://${host}/${encodeS3Key(o.key)}`,
              allowlist: egressHosts,
              sizeBytes: o.size,
            })),
            (url, start, body) => getWarmCache().put(url, start, body),
            { signal: getRunSignal() }
          ).catch(() => {});

          logger.info("WASM remote: enumerated hive source", {
            runId: getRunId(),
            files: aliases.length,
            totalBytes: objects.reduce((n, o) => n + o.size, 0),
          });
        } else if (sandboxRuntime === "wasm" && isRemote && !context.manifest) {
          ({ csvPath: wasmCsvPath } = await materializeRemoteCsvForWasm(stored, {
            workDir: hermeticPaths.scratchDir(),
          }));
        } else if (sandboxRuntime === "wasm" && isLocal && isLocalParquetSource(stored)) {
          // Local parquet, no bind-mount available: convert it host-side with the
          // in-process DuckDB and deliver the CSV — the same shape the remote wasm
          // path uses (D13), so the worker sees one delivery mechanism, not two.
          ({ csvPath: wasmCsvPath } = await materializeLocalParquetCsvForWasm({
            localPath: (stored.localFolderPath || stored.localPath)!,
            isFolder: Boolean(stored.localFolderPath),
            ...(stored.isHivePartitioned !== undefined
              ? { isHivePartitioned: stored.isHivePartitioned }
              : {}),
            rowCount: stored.schema.row_count,
            workDir: hermeticPaths.scratchDir(),
          }));
        }

        // ── Multi-entity manifest question (spec §7; delivery revised D40) ──
        // Shared with Investigate via lib/manifest/question-context — the two
        // pipelines must stay at par, so both call the SAME resolver + builder.
        // Docker: generated DuckDB reads each entity's URL (one host — the
        // same-host gate ran at connect, so the primary's egress grant covers
        // all). WASM (D40): NOTHING is materialized — every entity (hive
        // included) becomes run-scoped range-token aliases and DuckDB in the
        // worker reads only the row groups the question touches. This removed
        // the P2 CSV ceilings and the hive fail-closed guard in one move.
        let manifestContext: string | undefined;
        if (context.manifest && isRemote) {
          const resolvedManifest = resolveManifestQuestion(context.manifest, csvId);
          if (sandboxRuntime === "wasm") {
            const built = await buildManifestWasmAliases(
              resolvedManifest,
              getRunId() ?? undefined,
              {
                signal: getRunSignal(),
              }
            );
            wasmDuckDbAliases = built.aliases;
            manifestContext = buildManifestQuestionContext(resolvedManifest, {
              kind: "wasm-ranged",
              readExprs: built.readExprs,
            });
            // Warm every entity's parquet tail while Pyodide boots (D21 pattern) —
            // best-effort, never awaited, never fatal.
            void prefetchFooters(
              built.prefetch,
              (url, start, body) => getWarmCache().put(url, start, body),
              { signal: getRunSignal() }
            ).catch(() => {});
          } else {
            manifestContext = buildManifestQuestionContext(resolvedManifest, { kind: "docker" });
          }
          logger.info("Manifest question: multi-entity context", {
            runId: getRunId(),
            entities: resolvedManifest.entities.map((e) => e.name),
            runtime: sandboxRuntime,
            ...(sandboxRuntime === "wasm" ? { aliases: wasmDuckDbAliases?.length } : {}),
          });
        }

        // Build local file context for LLM prompt (tells it where to read
        // data). A materialized warehouse pull was docker-cp'd to
        // /data/input.parquet (no mount) — same resolvers as Investigate.
        const { localFileContext, remoteAuthSubst } = manifestContext
          ? // Multi-entity manifest: the built context lists EVERY entity's
            // location + schema; auth (docker only) comes from the primary's
            // creds — all entities share them (one manifest, one host).
            {
              localFileContext: manifestContext,
              remoteAuthSubst:
                sandboxRuntime === "wasm" ? undefined : remoteAuthSubstFor(stored.remoteCreds),
            }
          : warehouseParquetFile
            ? { localFileContext: warehouseParquetContext, remoteAuthSubst: undefined }
            : sandboxRuntime === "wasm" && isLocal
              ? // Delivered as /data/input.csv (the base prompt's default), whether it
                // started as a CSV or was converted from parquet — no mount to describe.
                { localFileContext: undefined, remoteAuthSubst: undefined }
              : isLocal
                ? { ...resolveLocalSource(stored), remoteAuthSubst: undefined }
                : wasmCsvPath
                  ? // Reads the delivered /data/input.csv (the base prompt's default) —
                    // NO httpfs, NO remoteAuthSubst.
                    { localFileContext: undefined, remoteAuthSubst: undefined }
                  : wasmHiveReadExpr
                    ? resolveWasmRemoteSource(
                        wasmHiveReadExpr,
                        stored.schema.row_count,
                        stored.isHivePartitioned
                      )
                    : isRemote
                      ? resolveRemoteSource(
                          stored.remoteParquetUrl!,
                          stored.schema.row_count,
                          stored.isHivePartitioned,
                          stored.remoteCreds
                        )
                      : { localFileContext: undefined, remoteAuthSubst: undefined };

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
            remoteAuthSubst,
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
            wasmFetchInputs: wasmCsvPath
              ? [{ workerPath: "/data/input.csv", hostPath: wasmCsvPath }]
              : undefined,
            wasmDuckDbAliases,
            purpose,
            remoteAuthSubst,
          });
        }
        // The host-materialized remote CSV is consumed once the worker fetched it.
        if (wasmCsvPath) await unlink(wasmCsvPath).catch(() => {});
        // Range tokens are capabilities: release them the moment the run is done so
        // a later request cannot reuse one (they are also run-scoped in the registry).
        if (wasmDuckDbAliases?.length) {
          const rid = getRunId();
          if (rid) getRangeRegistry().releaseRun(rid);
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
        // Analysis Product (spec §1): validate the declared series/values and
        // build the roles index the structured-first lints read in place of
        // column-name heuristics. Legacy envelopes get an empty index and the
        // lints fall back to inference.
        const { product, issues: productIssues } = parseProduct(
          executionResult.series,
          executionResult.values
        );
        const rolesIdx = productRolesIndex(product.series);
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
          // Auto-surface undeclared FAILED checks before anything reads the
          // manifest: a `<x>_passed: false` living only in results is
          // invisible to the caveat machinery, the banner, and the Verify
          // panel (two consecutive audits flagged the same silent failure).
          // Appended in place so the planner, compiler, lints and
          // verifiability all see one manifest.
          const surfacedChecks = surfaceUndeclaredFailedChecks(
            (executionResult.results ?? {}) as Record<string, unknown>,
            validated.manifest.findings
          );
          validated.manifest.findings.push(...surfacedChecks.added);
          // Same rule for computed SCREENS with no verdict key (run 5872407b:
          // an outlier screen the question literally asked for, invisible).
          const surfacedScreens = surfaceUndeclaredScreens(
            (executionResult.results ?? {}) as Record<string, unknown>,
            validated.manifest.findings
          );
          validated.manifest.findings.push(...surfacedScreens.added);
          // Symmetric subset dedup (run 9c415dc8): a poorer twin lacking the
          // method key dodges the in-surfacer dedup — drop it here, after
          // both surfacers have run.
          const twins = dedupeSurfacedTwins(validated.manifest.findings);
          if (twins.removed.length > 0) {
            validated.manifest.findings = validated.manifest.findings.filter(
              (f) => !twins.removed.includes(f.name)
            );
          }
          findingsManifest = validated.manifest;
          if (executionResult.runtime_fallback) {
            logger.error("Sandbox runtime fell back to stubs — findings degraded", {
              error: executionResult.runtime_fallback,
            });
          }
          for (const msg of normalizeHeadlineStats(
            (executionResult.results ?? {}) as Record<string, unknown>
          )) {
            logger.info("headline_stats normalized", { msg });
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
            ...surfacedChecks.issues,
            ...surfacedScreens.issues,
            ...twins.issues,
            ...lintOutlierDetectorDisagreement(
              (executionResult.results ?? {}) as Record<string, unknown>
            ),
            ...lintMislabeledAverage(
              (executionResult.results ?? {}) as Record<string, unknown>,
              validated.manifest.findings
            ),
            ...productIssues,
            ...lintDerivations(validated.manifest.findings),
            ...lintMissingLinkage(validated.manifest.findings),
            ...lintGranularityConflict(validated.manifest.findings),
            ...lintCheckGating(validated.manifest.findings),
            ...lintNoChecksDeclared(validated.manifest.findings),
            ...lintMethodMismatch(validated.manifest.findings),
            ...lintNullAncestry(validated.manifest.findings),
            ...lintDefinitionContradicted(validated.manifest.findings),
            ...lintResultsProvenance(
              (executionResult.results ?? {}) as Record<string, unknown>,
              validated.manifest.findings
            ),
            ...lintThinSuperlative(
              (executionResult.chart_data ?? {}) as Record<string, unknown>,
              validated.manifest.findings,
              rolesIdx
            ),
            ...lintWellAttestedScreened(
              (executionResult.chart_data ?? {}) as Record<string, unknown>,
              rolesIdx
            ),
            ...lintNullZeroMirror(
              (executionResult.results ?? {}) as Record<string, unknown>,
              validated.manifest.findings
            ),
            ...lintUnscreenedSuperlative(
              (executionResult.chart_data ?? {}) as Record<string, unknown>,
              validated.manifest.findings,
              rolesIdx
            ),
            ...lintScreenScopeMismatch(
              (executionResult.chart_data ?? {}) as Record<string, unknown>,
              validated.manifest.findings,
              rolesIdx
            ),
            ...lintSeriesConsumption(
              (executionResult.chart_data ?? {}) as Record<string, unknown>,
              rolesIdx
            ),
            ...lintUndeclaredScreen(
              (executionResult.chart_data ?? {}) as Record<string, unknown>,
              validated.manifest.findings,
              rolesIdx
            ),
            ...lintRegimePolicy(
              executionResult.regimes as Record<string, unknown> | undefined,
              (executionResult.chart_data ?? {}) as Record<string, unknown>,
              rolesIdx
            ),
            ...lintUnaggregatedRollup(
              (executionResult.chart_data ?? {}) as Record<string, unknown>,
              rolesIdx
            ),
            ...lintChartConsistency(
              (executionResult.chart_data ?? {}) as Record<string, unknown>,
              validated.manifest.findings,
              rolesIdx
            ),
            ...lintTrendContract(validated.manifest.findings),
            ...lintRangeFabrication(validated.manifest.findings, executionResult.data_completeness),
            ...lintCompletenessConflict(
              validated.manifest.findings,
              executionResult.data_completeness
            ),
            ...lintOrphanDecisionResult(
              (executionResult.results ?? {}) as Record<string, unknown>,
              validated.manifest.findings
            ),
            ...lintUnweightedCountedTrend(validated.manifest.findings, rolesIdx),
            ...lintMixedUnitGroupSeries(rolesIdx),
          ];
          // Exemplar quality veto: a run whose lints flagged severe defects
          // (shipped blocking failure, miscalibrated screens, thin-peak
          // headlines, mislabeled statistics) must not seed future runs —
          // the bank's admission bar is execution+validation, which this
          // week proved passes wrong-but-plausible analyses.
          {
            const SEVERE_FOR_BANK = new Set([
              "blocking_check_shipped",
              "screen_missed_superlative",
              "thin_superlative",
              "thin_current_state",
              "well_attested_screened",
              "statistic_mislabel",
              "unbacked_superlative",
              "runtime_fallback",
              "zero_sentinel_unapplied",
              // Referent-integrity class (MCP deep-dive review): an executed
              // screen with no declaration, and decisions with no finding.
              "undeclared_screen",
              "orphan_decision_result",
            ]);
            if (findingIssues.some((i) => SEVERE_FOR_BANK.has(i.kind))) {
              void vetoExemplarByRunId(getRunId() ?? "unknown").catch(() => {});
            }
          }
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
          ...(product.series.length > 0 ? { series: product.series } : {}),
          ...(executionResult.regimes
            ? { regimes: executionResult.regimes as Record<string, unknown> }
            : {}),
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
            sight: context.composer_sight === "sighted" ? "sighted" : "blind",
            purpose,
            priorTurns,
            drillDownContext,
            workbookContext,
            // Recompiles honor the user's existing overlay (edit continuity).
            planOverlay: getCachedArtifacts(csvId)?.plan?.overlay,
          },
          uiComposeModel,
          emit,
          isClosed: stream.isClosed,
          onComposing: () => emitProgress("composing", stepOffset + 3),
          // Compiled mode: persist the plan document beside the artifacts so
          // the mutation API (/api/plan, MCP edit_dashboard) can edit it.
          onPlanDocument: (doc) => {
            const prior = getCachedArtifacts(csvId);
            if (prior) cacheArtifacts(csvId, { ...prior, plan: doc });
          },
        });
      } catch (pipelineErr) {
        const errMsg = errMessage(pipelineErr);
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
                  content: isContextLengthError(errMsg)
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
