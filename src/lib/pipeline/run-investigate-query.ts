import type { Spec } from "@/spec/core";
import { generatePlan } from "@/lib/llm/investigate-planner";
import {
  runInvestigation,
  deriveAnalysisWindow,
  type InvestigateProgressEvent,
} from "@/lib/pipeline/investigate-orchestrator";
import { mergeStepEntries, buildDataQuality } from "./investigate-merge";
import { getRunSignal } from "@/lib/pipeline/run-control";
import { runPipeline } from "@/lib/pipeline/orchestrator";
import { prewarmCodeGenCache } from "@/lib/llm/code-generation";
import { runWithCostTracking } from "@/lib/cost/accumulator";
import { emitCostEpilogue } from "@/lib/cost/epilogue";
import { runWithDiagnostics, diagEvent } from "@/lib/diagnostics/run-diagnostics";
import { composeAndStreamDashboard } from "@/lib/pipeline/dashboard-compose";
import { classifyFollowupDepth } from "@/lib/llm/followup-classifier";
import { tryConsumeAutoInvestigation } from "@/lib/pipeline/auto-investigation-budget";
import {
  MAX_AUTO_INVESTIGATIONS_PER_SESSION,
  PLANNER_MODEL,
  WAREHOUSE_MAX_ROWS,
  WAREHOUSE_SCAN_ROW_BUDGET,
} from "@/lib/constants";
import { getPurposeMaxSubQuestions } from "@/lib/purpose-prompts";
import { runWarehouseQuery } from "@/lib/warehouse/run-query";
import { storeWarehouseResult } from "@/lib/warehouse/materialize-result";
import { resolveLocalSource, resolveRemoteSource } from "@/lib/parquet/duckdb-source";
import type { RemoteAuthSubst } from "@/lib/parquet/duckdb-source";
import { composeInvestigation } from "@/lib/llm/investigate-composer";
import { buildValuesSection } from "@/lib/pipeline/dashboard-compose";
import { composeStepCell } from "@/lib/llm/step-cell-composer";
import { createSpecFinalizer, type SpecPatch } from "@/lib/llm/finalize-spec-stream";
import { cacheArtifacts, getCachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import {
  findingsMode,
  mergeDeclarations,
  validateFindings,
  lintDerivations,
  lintCrossStepDerivations,
  lintCrossStepReconciliation,
  surfaceUndeclaredFailedChecks,
  surfaceUndeclaredScreens,
  dedupeSurfacedTwins,
  lintUnitPhrase,
  lintSentinelInterpolation,
  lintSignedLanguage,
  lintSignificanceMismatch,
  lintMissingLinkage,
  lintGranularityConflict,
  lintTrendContract,
  lintCheckGating,
  lintNoChecksDeclared,
  lintMethodMismatch,
  lintNullAncestry,
  lintDefinitionContradicted,
  lintThinSuperlative,
  lintSuperlativeHidesRaw,
  lintWellAttestedScreened,
  lintUnscreenedSuperlative,
  lintScreenScopeMismatch,
  lintSeriesConsumption,
  lintUndeclaredScreen,
  lintDanglingFindingReference,
  lintOrphanDecisionResult,
  lintUnweightedCountedTrend,
  lintMixedUnitGroupSeries,
  lintChartConsistency,
  namespaceFindings,
} from "@/lib/findings";
import {
  mergeStepProducts,
  productRolesIndex,
  declaredUnitMap,
  buildCatalogSection,
} from "@/lib/product";
import { lintComponentSignature } from "@/lib/product/signatures";
import { isCompiledComposerEligible } from "@/lib/runtime-config";
import { compileDashboard } from "@/lib/compose/compile";
import { generatePlan as generateNarrativePlan } from "@/lib/compose/planner";
import { deriveViews, viewPromptTitle } from "@/lib/compose/views";
import { planHeadlineTiles } from "@/lib/findings/headline-plan";
import {
  FINDINGS_MANIFEST_VERSION,
  type FindingEntry,
  type FindingIssue,
  type FindingsManifest,
} from "@/lib/contracts/findings";
import {
  buildInvestigationTrace,
  successfulStepNos,
  TraceRecorder,
} from "@/lib/pipeline/investigation-trace";
import {
  collectGroundedValues,
  collectStringLeaves,
  verifyGrounding,
  extractCitedSteps,
  extractPlaceholderCitedSteps,
  collectNarrativeStrings,
} from "@/lib/pipeline/grounding";
import {
  getStoredCSV,
  getCSVContent,
  getGeoJSONContent,
  isLocalFile,
  isRemoteFile,
} from "@/lib/csv/storage";
import { prewarmSQLGenCache } from "@/lib/sqlgen/sql-generation";
import { logger, serializeError, errMessage } from "@/lib/logger";
import type { PatchStream } from "@/lib/pipeline/patch-stream";
import type { ResolvedAnalysisSource } from "@/lib/pipeline/validate-request";
import type { AnalysisRequestContext } from "@/lib/contracts/analysis-request";
import type { SandboxRuntimeId } from "@/lib/constants";

/**
 * The Investigate analysis, decoupled from HTTP (modularization M3-3b).
 *
 * This is the /api/query/investigate route body, lifted VERBATIM: warehouse
 * materialization -> source resolution -> drill cost gate -> plan ->
 * multi-wave execution -> compose/notebook-cells -> grounding -> trail, with
 * the cost/diagnostics epilogue in a finally. The route (or the WS8 CLI)
 * owns transport. See run-ask-query.ts for the AskRunState rationale —
 * runState.csvId is shared mutable state with the disconnect handler.
 */

export interface InvestigateRunState {
  csvId: string | undefined;
  question: string;
}

export interface RunInvestigateQueryArgs {
  context: AnalysisRequestContext;
  question: string;
  /**
   * Discriminated source from validate-request: a stored CSV (upload/local/
   * remote — or an already-materialized warehouse pull on a follow-up) or a
   * live warehouse connection. Narrowing `kind` once here replaced the
   * csvId!/warehouseState! assertions this file carried.
   */
  source: ResolvedAnalysisSource;
  codeGenModel: string;
  uiComposeModel: string;
  sandboxRuntime: SandboxRuntimeId;
  runState: InvestigateRunState;
  stream: PatchStream;
}

export async function runInvestigateQuery(args: RunInvestigateQueryArgs): Promise<void> {
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

  // Narrowed once; a const so the closures below (per-step SQL executor,
  // prewarm) see the non-null type without re-asserting.
  const warehouseState = source.kind === "warehouse" ? source.warehouseState : null;
  // Compose notebook cells eagerly only when the client is in Notebook view;
  // otherwise they're composed lazily on Notebook-open (cost optimization).
  const composeCells = context.compose_cells !== false;
  let datasetLabel =
    runState.csvId ?? (source.kind === "warehouse" ? source.warehouseId : source.csvId);
  let analysisMode = "investigate";

  const emit = stream.emit;
  const closed = () => stream.isClosed();
  const emitProgress = stream.emitProgress;
  // Make this run discoverable by a reconnecting client (run-stream-hub).
  stream.setMeta({ csvId: runState.csvId ?? undefined, question });

  await runWithCostTracking(() =>
    runWithDiagnostics(async () => {
      // Hoisted above the try so the catch can persist the partial
      // per-step trail when the run dies mid-investigation (OBS-8).
      let trailRecorder: TraceRecorder | null = null;
      try {
        // ── Step 0 (warehouse only): materialize via one broad SQL pull ──
        // The pull is intentionally row-level (not pre-aggregated): the
        // sub-questions aren't known yet, so the materialized CSV must
        // leave room for whatever angles the planner takes.
        let warehouseSQL: string | undefined;
        // True when the materialized pull hit the row cap — i.e. the analysis
        // ran over a sample, so aggregates/rankings are estimates. Surfaced
        // in the dashboard so we never present a biased subset as the truth.
        let materializationSampled = false;
        // How many SQL repairs the up-front pull needed (0 = clean first try).
        let materializationRepairs = 0;
        // Set when a large pull was materialized to Parquet: the host file to
        // copy into the sandbox (docker cp → /data/input.parquet) and the
        // DuckDB read instructions for the analysis.
        let warehouseParquetFile: string | undefined;
        let warehouseParquetContext: string | undefined;
        // The analysis' data id: the csv source directly, or the snapshot the
        // warehouse pull materializes below. Guaranteed a string past this
        // block — downstream stages previously asserted `csvId!` per read.
        let csvId: string;
        if (source.kind === "warehouse") {
          const { warehouse, connector } = source.warehouseState;
          emitProgress("generating_sql", 1, 99);

          // Bound the scan + self-heal via the SHARED warehouse path —
          // runWarehouseQuery (scan-window from engine metadata, then
          // generate → execute → repair) is the SAME hardening Ask uses, so
          // every future SQL-reliability fix lands in one place.
          const materializationQuestion =
            `Pull the ROW-LEVEL data that later analysis steps will need to investigate this question: ${question}\n` +
            `Return RAW ROWS — NOT pre-aggregated summaries and NOT the final analysis. Do NOT compute pairwise/co-occurrence counts, GROUP BY rollups, or joins here; later steps do that. Just select the relevant rows with every column plausibly useful (dimensions, dates, measures).\n` +
            `Keep the query SIMPLE and keep the SCAN small so it stays under the engine's read limit. The ONLY reliable way to bound the scan on a large table is a SELECTIVE WHERE on the partition/date key: prefer a BOUNDED recent window (e.g. the most recent ~3 months that has data), plus any obvious status/category filter. Then LIMIT ${WAREHOUSE_MAX_ROWS}.\n` +
            `Do NOT add an ORDER BY: sorting a wide, million-row result set blows the engine's sort memory (MEMORY_LIMIT_EXCEEDED). A row-level pull does not need to be ordered — later steps sort the small aggregates they compute. Just filter and LIMIT.\n` +
            `Do NOT use SAMPLE (many tables don't support it) and do NOT use a hash/modulo filter like \`cityHash64(...) % N\` — those still SCAN every row and fail with "rows to read exceeded". A bounded date window is what keeps the scan small.`;
          let warehouseCsvContent: string;
          try {
            const outcome = await runWarehouseQuery({
              signal: getRunSignal(),
              tables: warehouse.tableSchemas,
              connector,
              warehouseType: warehouse.config.type,
              question: materializationQuestion,
              model: codeGenModel,
              scanRowBudget: WAREHOUSE_SCAN_ROW_BUDGET,
              onAttempt: (attempt, phase) => {
                if (phase === "repairing") {
                  materializationRepairs++;
                  emitProgress("generating_sql", 1, 99);
                  logger.info("Investigate: repairing warehouse SQL", { attempt });
                } else if (phase === "executing") {
                  emitProgress("querying_warehouse", 1, 99);
                }
              },
            });
            warehouseSQL = outcome.sql;
            warehouseCsvContent = outcome.csv;
          } catch (err) {
            const msg = errMessage(err);
            throw new Error(
              `Warehouse query failed after repair attempts: ${msg}` +
                (warehouseSQL ? `\n\nLast SQL:\n${warehouseSQL}` : "")
            );
          }
          logger.info("Investigate: warehouse SQL executed", { sql: warehouseSQL });
          // Store the pull (Parquet for large results, CSV otherwise) via
          // the SHARED module — lib/warehouse/materialize-result.ts.
          const storedResult = await storeWarehouseResult({
            csvContent: warehouseCsvContent,
            warehouseType: warehouse.config.type,
            sandboxRuntime,
            emit,
            sqlRepairs: materializationRepairs,
          });
          csvId = storedResult.csvId;
          runState.csvId = csvId;
          stream.setMeta({ csvId }); // warehouse csvId now known
          materializationSampled = storedResult.sampled;
          warehouseParquetFile = storedResult.parquetFile;
          warehouseParquetContext = storedResult.parquetContext;
        } else {
          csvId = source.csvId;
        }

        // ── Resolve the source (file upload, local mount, or the CSV
        //     just materialized from the warehouse) ──
        const stored = getStoredCSV(csvId);
        if (!stored) {
          throw new Error("CSV not found or expired");
        }
        datasetLabel = stored.schema.filename;
        const isLocal = isLocalFile(csvId);
        const isRemote = isRemoteFile(csvId);
        // In Parquet mode (local mount, materialized warehouse, or remote
        // URL) the analysis reads Parquet directly, so we never load the
        // (large) CSV into memory.
        const csvContent =
          isLocal || isRemote || warehouseParquetFile ? "" : ((await getCSVContent(csvId)) ?? "");
        const geojsonContent = stored.schema.has_geojson ? await getGeoJSONContent(csvId) : null;

        // Mount path + code-gen "Data Location" context. A materialized
        // warehouse pull was docker-cp'd to /data/input.parquet (no mount);
        // a browsed local file resolves via the shared resolver; a remote
        // cloud Parquet URL is read directly by DuckDB (no mount). Same
        // resolvers as /api/query.
        let localMountPath: string | undefined;
        let localFileContext: string | undefined;
        let remoteAuthSubst: RemoteAuthSubst | undefined;
        if (warehouseParquetFile) {
          localFileContext = warehouseParquetContext;
        } else if (isLocal) {
          ({ localMountPath, localFileContext } = resolveLocalSource(stored));
        } else if (isRemote) {
          ({ localFileContext, remoteAuthSubst } = resolveRemoteSource(
            stored.remoteParquetUrl!,
            stored.schema.row_count,
            stored.isHivePartitioned,
            stored.remoteCreds
          ));
        }

        // ── Drill-as-sub-investigation cost gate ──
        // A scoped follow-up (chart drill or sticky follow-up) is classified
        // lookup-vs-deep. Lookups — and any auto-routed follow-up beyond the
        // per-session budget — answer with a single-shot dashboard instead of
        // a full multi-step investigation, so LLM cost stays bounded. The gate
        // is lookup-biased and fail-safe: a classifier error defaults to the
        // cheap path. Fresh (unscoped) investigations are never gated.
        if (context.scope) {
          const scope = context.scope;
          const depth = await classifyFollowupDepth({ question, scope });
          // csvId is guaranteed by the source union (materialized above for
          // warehouse runs) — the old `?? warehouseId ?? "default"` fallbacks
          // were dead.
          const budgetKey = csvId;
          const goDeep =
            depth === "deep" &&
            tryConsumeAutoInvestigation(budgetKey, MAX_AUTO_INVESTIGATIONS_PER_SESSION);
          if (!goDeep) {
            logger.info("Investigate: scoped follow-up routed to single-shot", {
              depth,
              question: question.slice(0, 120),
            });
            const drillDownContext = scope.filters?.length
              ? {
                  parent_question: scope.parent_question ?? question,
                  filter_column: scope.filters[0].column,
                  filter_value: scope.filters[0].value,
                  segment_label: scope.segment_label ?? "",
                  chart_title: null,
                  additional_filters: scope.filters.slice(1),
                }
              : null;
            const cheap = await runPipeline(stored.schema, csvContent || "", question, {
              onStage: (stage) => {
                if (stage === "generating_code") emitProgress("analyzing", 1, 3);
                else if (stage === "executing") emitProgress("computing", 2, 3);
              },
              model: codeGenModel,
              runtime: sandboxRuntime,
              geojsonContent,
              localMountPath,
              localFileContext,
              remoteAuthSubst,
            });
            await composeAndStreamDashboard({
              executionResult: cheap.executionResult,
              opts: {
                question,
                schema: stored.schema,
                schemaMode: "metadata",
                purpose: context.purpose ?? "dashboard",
                priorTurns: [],
                drillDownContext,
              },
              uiComposeModel,
              emit,
              isClosed: stream.isClosed,
              onComposing: () => emitProgress("composing", 3, 3),
            });
            analysisMode = "ask"; // routed to the single-shot lookup path
            return;
          }
        }

        // ── Step 1: Plan ──
        emitProgress("planning", 1, 99);
        // For warehouse investigations, give the planner the FULL table
        // schemas (so sub-questions can span tables that per-step SQL will
        // join) alongside the materialized schema.
        const planResult = await generatePlan(
          question,
          stored.schema,
          warehouseState?.warehouse.tableSchemas,
          PLANNER_MODEL,
          context.scope,
          context.purpose
        );
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
          if (!composeCells) return; // lazy-composed on Notebook-open instead
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

        // Audit-trail accumulation (decision log + per-step provenance)
        // lives in lib — see TraceRecorder in investigation-trace.ts. The
        // onProgress handler below keeps only the stream-emit wiring.
        const recorder = new TraceRecorder();
        trailRecorder = recorder;

        // Warm the code-gen prompt cache before the first wave fans out in
        // parallel, so concurrent sub-questions read it instead of each
        // cold-writing the (cached) prefix. File investigations share one
        // schema across all sub-questions → warm the whole prefix (system +
        // schema). Warehouse investigations run per-step SQL → a different
        // schema per sub-question, so only the (large) system prompt is
        // shared → warm system-only (warming the schema would be a wasted
        // write nothing reads). Per-step schemas inherit the table's domain
        // (see runWarehouseSubQuestion) so every step's system prompt is
        // byte-identical to this warm-up and hits the cache.
        // For warehouse runs, also warm the SQL-gen cache: every
        // sub-question generates its own SQL from the SAME table schema, so
        // without this each wave-0 SQL generation cold-writes that schema in
        // parallel. Run both warm-ups concurrently — they're independent and
        // both best-effort.
        //
        // Prewarm only pays off when wave-0 fans out across ENOUGH parallel
        // steps to amortize its cache-WRITE: it trades K cold writes for 1
        // warm write + K reads. At ≤2 steps that trade is roughly break-even
        // and the extra prewarm call's write (~$0.02-0.04, seen as a large
        // prewarm phase on tiny runs) isn't recovered — so skip it and let the
        // 1-2 steps cold-write directly.
        if (plan.subQuestions.length > 2) {
          await Promise.all([
            prewarmCodeGenCache(
              stored.schema,
              "metadata",
              codeGenModel,
              undefined,
              warehouseState ? undefined : localFileContext,
              !!warehouseState, // systemOnly for warehouse
              context.purpose // same purpose → same cached system prompt
            ),
            warehouseState
              ? prewarmSQLGenCache(
                  warehouseState.warehouse.tableSchemas,
                  warehouseState.warehouse.config.type,
                  codeGenModel
                )
              : Promise.resolve(),
          ]);
        }

        const subResults = await runInvestigation(plan.subQuestions, {
          schema: stored.schema,
          csvContent,
          geojsonContent,
          workbookContext: undefined,
          localMountPath,
          localFileContext,
          remoteAuthSubst,
          inputParquetPath: warehouseParquetFile,
          runtime: sandboxRuntime,
          model: codeGenModel,
          originalQuestion: question,
          approach: plan.approach,
          // Scales each step's analysis volume to the output mode.
          purpose: context.purpose,
          // Purpose-scoped cap on total sub-questions (dashboard/brief 3,
          // report 4, deep-dive 10) — bounds re-plan/gap-check growth.
          maxSubQuestions: getPurposeMaxSubQuestions(context.purpose ?? "dashboard"),
          // Warehouse steps generate their OWN window-bounded query and analyze
          // the small result (per-step SQL is the default; CSV-snapshot analysis
          // is only the fallback if SQL fails). The materialization SQL is passed
          // so each per-step query reuses the same time window. File
          // investigations leave this undefined and run Python over the shared CSV.
          warehouse: warehouseState
            ? {
                tables: warehouseState.warehouse.tableSchemas,
                warehouseType: warehouseState.warehouse.config.type,
                materializationSQL: warehouseSQL,
                executor: (sql: string) => warehouseState.connector.executeSQL(sql),
              }
            : undefined,
          onProgress: (event) => {
            recorder.record(event);
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

        // NOTE: deliberately NO `if (closed()) return` here — the same
        // fix as the Ask route. A multi-step investigation is the most
        // expensive thing this app runs; a client disconnect during it
        // must not discard the completed sub-analyses. The trace is
        // cached, compose streams into the dead socket (emit no-ops),
        // and persistHistoryOnDisconnect saves the assembled spec for
        // the History panel.

        // Build the full audit trail: every sub-question's code + result,
        // the re-planner / composer decisions, and (added after compose) the
        // grounding verdict. This is what the artifacts panel renders as a
        // re-runnable per-step trail — the agentic loop extending Hermetic's
        // "see the Python and re-run it" moat, not outrunning it.
        const trace = buildInvestigationTrace({
          approach: plan.approach,
          originalQuestion: question,
          subResults,
          sourceByIndex: recorder.sourceByIndex,
          decisions: recorder.decisions,
        });

        // Cache artifacts under the csvId. The top-level code/results mirror
        // the LAST successful step (back-compat with the single-view panel);
        // `investigation` carries the whole trail. Cached before compose so a
        // composer failure still leaves an inspectable trail; `trace.grounding`
        // is set below on the same object, so the cached entry sees it too.
        const lastSuccess = [...subResults].reverse().find((r) => r.result);
        const prior = getCachedArtifacts(csvId);
        const topLevel = lastSuccess?.result
          ? {
              code: lastSuccess.result.generatedCode,
              question,
              results: lastSuccess.result.executionResult.results as Record<string, unknown>,
              chart_data: lastSuccess.result.executionResult.chart_data as Record<string, unknown>,
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
        // ── Declared findings, investigate shape (spec §7): validate each
        // step's declarations under BARE names (the meta-schema forbids
        // dots), then namespace to step_N.<name>, then run the cross-step
        // lints (DAG-checked derivations; reconciliation of overlapping
        // measures that disagree). Shadow collects; "on" ships (§8).
        const fMode = findingsMode();
        let investigationFindings: FindingsManifest | undefined;
        if (fMode !== "off") {
          const merged: FindingEntry[] = [];
          subResults.forEach((r, idx) => {
            const raw = r.result?.executionResult.findings;
            if (!Array.isArray(raw)) return;
            const entries = mergeDeclarations(
              raw.filter(
                (f): f is FindingEntry =>
                  !!f && typeof f === "object" && !("__dropped__" in (f as object))
              )
            );
            const stepNo = idx + 1; // 1-based, = planner index + 1 (§7.0)
            const validated = validateFindings(entries);
            // Auto-surface this step's undeclared FAILED checks before
            // namespacing, so a `<x>_passed: false` living only in step
            // results still reaches the caveat machinery (same rule as the
            // ask path; see surfaceUndeclaredFailedChecks).
            const surfaced = surfaceUndeclaredFailedChecks(
              (r.result?.executionResult.results ?? {}) as Record<string, unknown>,
              validated.manifest.findings
            );
            // Checks additions land BEFORE the screens surfacer runs: its
            // evidence-equality dedup (run 31c1cfa9) compares candidates
            // against everything already in the manifest, including what the
            // checks surfacer just added.
            validated.manifest.findings.push(...surfaced.added);
            const surfacedScr = surfaceUndeclaredScreens(
              (r.result?.executionResult.results ?? {}) as Record<string, unknown>,
              validated.manifest.findings
            );
            validated.manifest.findings.push(...surfacedScr.added);
            // Symmetric subset dedup (run 9c415dc8) — after both surfacers.
            const twins = dedupeSurfacedTwins(validated.manifest.findings);
            if (twins.removed.length > 0) {
              validated.manifest.findings = validated.manifest.findings.filter(
                (f) => !twins.removed.includes(f.name)
              );
              logger.warn("investigate findings: duplicate surfaced twins dropped", {
                stepNo,
                removed: twins.removed,
              });
            }
            if (surfaced.added.length > 0 || surfacedScr.added.length > 0) {
              logger.warn("investigate findings: undeclared checks/screens auto-surfaced", {
                stepNo,
                checks: [...surfaced.added, ...surfacedScr.added].map((f) => f.name),
              });
            }
            const dagIssues = lintCrossStepDerivations(
              validated.manifest.findings,
              stepNo,
              plan.subQuestions[idx]?.depends_on ?? []
            );
            if (dagIssues.length > 0) {
              logger.warn("investigate findings: derivation outside depends_on DAG", {
                stepNo,
                issues: dagIssues.map((i) => i.detail),
              });
            }
            merged.push(...namespaceFindings(stepNo, validated.manifest.findings));
          });
          if (merged.length > 0) {
            const coherence = [
              ...lintDerivations(merged),
              ...lintCrossStepReconciliation(merged),
              ...lintMissingLinkage(merged),
              ...lintGranularityConflict(merged),
              ...lintTrendContract(merged),
              ...lintCheckGating(merged),
              ...lintNoChecksDeclared(merged),
              ...lintMethodMismatch(merged),
              ...lintNullAncestry(merged),
              ...lintDefinitionContradicted(merged),
            ];
            if (coherence.length > 0) {
              logger.warn("investigate findings: cross-step coherence issues", {
                issues: coherence.map((i) => `${i.kind}: ${i.detail}`),
              });
            }
            investigationFindings = {
              manifest_version: FINDINGS_MANIFEST_VERSION,
              findings: merged,
            };
          }
        }

        // ── Analysis Product, investigate shape (spec §7): merge each step's
        // declared series/values under the composer's step_N_ data prefix,
        // with of/screened_by refs following the step_N. finding rename —
        // the roles index then keys the merged chart_data exactly.
        const { product: investigationProduct, issues: productIssues } = mergeStepProducts(
          subResults
            .filter((r) => !r.removed && r.result)
            .map((r) => ({
              stepNo: r.index + 1,
              series: r.result!.executionResult.series,
              values: r.result!.executionResult.values,
            }))
        );
        const investigateRolesIdx = productRolesIndex(investigationProduct.series);
        // Regime profiles under the same step_N_ prefix as the merged
        // series ids — keyed for the view catalog and the edit recompile.
        const investigationRegimes = mergeStepEntries(subResults, (er) => er.regimes);
        if (productIssues.length > 0) {
          logger.warn("investigate product: invalid declarations dropped", {
            issues: productIssues.map((i) => i.detail),
          });
        }

        cacheArtifacts(csvId, {
          ...topLevel,
          investigation: trace,
          ...(investigationFindings ? { findings: investigationFindings } : {}),
          ...(investigationProduct.series.length > 0
            ? { series: investigationProduct.series }
            : {}),
          ...(Object.keys(investigationRegimes).length > 0
            ? { regimes: investigationRegimes }
            : {}),
        });

        // Deterministic data-quality surfacing — guarantees degraded / failed
        // / dropped branches reach the user regardless of whether the composer
        // remembered to annotate them. Rendered as a banner above the
        // dashboard by ResponsePanel.
        const dataQuality = buildDataQuality(trace.steps);
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

        // Sighted mode (composer-sight spec §1): derived per-step aggregates
        // + finding values, never raw rows. Built from subResults with the
        // same step_N_ namespacing the composer uses.
        const sightedValuesSection = (() => {
          if (context.composer_sight !== "sighted") return undefined;
          const res = mergeStepEntries(subResults, (er) => er.results);
          const charts = mergeStepEntries(subResults, (er) => er.chart_data);
          return buildValuesSection(
            { results: res, chart_data: charts, datasets: {}, execution_ms: 0 } as never,
            fMode === "on" ? (investigationFindings ?? undefined) : undefined
          );
        })();
        let investigatePlanDoc: import("@/lib/contracts/plan").PlanDocument | null = null;
        // Compiled composer (narrative-compiler spec §3): plan + deterministic
        // compile over the MERGED manifest/product; lines flow through the
        // same finalize loop below. Legacy merges fall back to generative.
        const compiledMode = isCompiledComposerEligible(
          investigationProduct.series.length,
          investigationFindings?.findings.length ?? 0
        );
        const compose = compiledMode
          ? (() => {
              const res = mergeStepEntries(subResults, (er) => er.results);
              const charts = mergeStepEntries(subResults, (er) => er.chart_data);
              return {
                initialState: { results: res, chart_data: charts },
                textStream: (async function* () {
                  const shippedViews = deriveViews({
                    series: investigationProduct.series,
                    regimes: investigationRegimes,
                    purpose: context.purpose,
                  }).filter((v) => v.shipped);
                  // Investigate's merge step-prefixes chart_data keys, so
                  // the geometry channel resolves the ACTUAL key (e.g.
                  // "step_2_geojson"), not the bare convention name.
                  const geojsonKey = Object.keys(charts).find(
                    (k) => k === "geojson" || k.endsWith("_geojson")
                  );
                  // Declared payloads, step-prefixed like every merged
                  // chart_data key (their data already lives in `charts`
                  // under the same prefixed ids).
                  const mergedPayloads: { id: string; format: string }[] = [];
                  for (const sub of subResults) {
                    if (sub.removed || !sub.result) continue;
                    const pl = (sub.result.executionResult as { payloads?: unknown }).payloads;
                    if (!Array.isArray(pl)) continue;
                    for (const p of pl as { id?: unknown; format?: unknown }[]) {
                      if (typeof p?.id === "string" && typeof p?.format === "string") {
                        mergedPayloads.push({
                          id: `step_${sub.index + 1}_${p.id}`,
                          format: p.format,
                        });
                      }
                    }
                  }
                  const { plan } = await generateNarrativePlan({
                    findings: investigationFindings!.findings,
                    question,
                    model: uiComposeModel,
                    purpose: context.purpose,
                    views: shippedViews.map((v) => ({ id: v.id, title: viewPromptTitle(v) })),
                    series: investigationProduct.series,
                    payloads: mergedPayloads,
                    hasGeojson: geojsonKey !== undefined,
                  });
                  investigatePlanDoc = {
                    plan,
                    overlay: {},
                    mode: "compiled" as const,
                    purpose: context.purpose,
                    // Persist the step-prefixed geometry key so the edit-path
                    // recompile re-injects the same map (finding 08/H3) — the
                    // cached top-level chart_data is the LAST step's, not the
                    // merged step-prefixed set, so it cannot be re-derived.
                    ...(geojsonKey ? { geojsonKey } : {}),
                  };
                  yield compileDashboard({
                    manifest: investigationFindings!,
                    product: investigationProduct,
                    plan,
                    geojsonKey,
                    overlay: {},
                    headlinePlan: planHeadlineTiles(
                      investigationFindings!.findings,
                      res,
                      question,
                      investigationProduct.values,
                      context.purpose
                    ),
                    question,
                    purpose: context.purpose,
                    regimes: investigationRegimes,
                  }).join("\n") + "\n";
                })(),
              };
            })()
          : composeInvestigation({
              originalQuestion: question,
              plan,
              schema: stored.schema,
              subResults,
              // §7.5 synthesis binding — consumers receive the manifest only in
              // mode "on" (assembled above, before composition).
              ...(fMode === "on" && investigationFindings
                ? { findings: investigationFindings }
                : {}),
              uiComposeModel,
              purpose: context.purpose,
              // Warehouse investigations cover the materialized pull's time
              // window; surface it so the dashboard states its scope.
              analysisWindow: warehouseState ? deriveAnalysisWindow(stored.schema) : undefined,
              // When the pull hit the row cap, the analysis is over a sample —
              // tell the composer to disclose it.
              sampleRows: materializationSampled ? WAREHOUSE_MAX_ROWS : undefined,
              // Catalog is structure-only (blind-safe); the sighted values
              // section rides behind it when enabled.
              extraSection:
                [
                  buildCatalogSection(investigationProduct)
                    ? `\n\n${buildCatalogSection(investigationProduct)}`
                    : "",
                  sightedValuesSection ?? "",
                ].join("") || undefined,
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

        const ingestComposedLine = (preResolution: string, patch: SpecPatch | null) => {
          // Raw line: only unambiguous $result/$chartData placeholders count
          // as citations — prose-scanning the raw JSON would match element
          // IDs / key paths named after steps and suppress the
          // uncited-steps advisory.
          for (const n of extractPlaceholderCitedSteps(preResolution)) citedSteps.add(n);
          if (patch && "value" in patch) {
            const isSummary = !!patch.path && SUMMARY_PATH_RE.test(patch.path);
            const isConclusion = !isSummary && !!patch.path && CONCLUSION_PATH_RE.test(patch.path);
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
        };

        // Shared finalization stage (placeholder resolution + $state repair),
        // identical to Ask mode. Investigate inlines per-step data via
        // $chartData/$result, so no DataController $state repair is needed.
        const investigateFindingValues = Object.fromEntries(
          (fMode === "on" ? (investigationFindings?.findings ?? []) : []).map((f) => [
            f.name,
            f.value,
          ])
        );
        const citedFindingNames = new Set<string>();
        const investigateUnitByName = new Map<string, string>(
          (fMode === "on" ? (investigationFindings?.findings ?? []) : [])
            .filter((f) => typeof f.unit === "string" && f.unit.length > 0)
            .map((f) => [f.name, f.unit as string])
        );
        const investigateFindingValueMap = new Map<string, unknown>(
          Object.entries(investigateFindingValues)
        );
        const proseLintIssues = new Map<string, FindingIssue>();
        // Structured product lints over the MERGED views (spec §7): with the
        // roles index keyed to step_N_ chart keys, the same screen/attestation
        // /consistency battery Ask runs applies to an investigation.
        {
          const mergedFindingEntries = investigationFindings?.findings ?? [];
          for (const issue of [
            ...productIssues,
            ...lintThinSuperlative(mergedChartData, mergedFindingEntries, investigateRolesIdx),
            ...lintWellAttestedScreened(mergedChartData, investigateRolesIdx),
            ...lintUnscreenedSuperlative(
              mergedChartData,
              mergedFindingEntries,
              investigateRolesIdx
            ),
            ...lintScreenScopeMismatch(mergedChartData, mergedFindingEntries, investigateRolesIdx),
            ...lintSeriesConsumption(mergedChartData, investigateRolesIdx),
            ...lintUndeclaredScreen(mergedChartData, mergedFindingEntries, investigateRolesIdx),
            ...lintChartConsistency(mergedChartData, mergedFindingEntries, investigateRolesIdx),
            ...lintOrphanDecisionResult(
              mergedResults as Record<string, unknown>,
              mergedFindingEntries
            ),
            ...lintUnweightedCountedTrend(mergedFindingEntries, investigateRolesIdx),
            ...lintMixedUnitGroupSeries(investigateRolesIdx),
          ]) {
            proseLintIssues.set(`${issue.kind}:${issue.name ?? issue.detail}`, issue);
          }
        }
        const lintComposedLine = (raw: string) => {
          const lookup = {
            findings: investigateFindingValueMap,
            results: mergedResults as Record<string, unknown>,
          };
          for (const issue of [
            ...lintUnitPhrase(raw, investigateUnitByName),
            ...lintSentinelInterpolation(raw, lookup),
            ...lintSignedLanguage(raw, lookup),
            ...lintSignificanceMismatch(raw, lookup),
            ...lintComponentSignature(raw, investigateRolesIdx),
          ]) {
            proseLintIssues.set(`${issue.kind}:${issue.name ?? issue.detail}`, issue);
          }
        };
        const finalize = createSpecFinalizer({
          results: mergedResults,
          chartData: mergedChartData,
          findings: investigateFindingValues,
          findingUnits: Object.fromEntries(investigateUnitByName),
          // Declared units keyed to the MERGED result namespace: value keys
          // already carry step_N_; finding mirrors live at step_N_<name>_<field>,
          // so the step_N. manifest name is mapped to its data-prefix form.
          declaredUnits: declaredUnitMap(
            investigationProduct.values,
            (investigationFindings?.findings ?? []).map((f) => ({
              name: f.name.replace(/^step_(\d+)\./, "step_$1_"),
              ...(typeof f.unit === "string" ? { unit: f.unit } : {}),
            }))
          ),
        });

        let buffer = "";
        for await (const chunk of compose.textStream) {
          if (closed()) break;
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const r = finalize(line);
            if (r.skip) continue;
            for (const m of r.raw.matchAll(/\$finding:(step_\d+\.[a-zA-Z0-9_]+)/g)) {
              citedFindingNames.add(m[1]);
            }
            lintComposedLine(r.raw);
            for (const issue of r.discourseIssues ?? []) {
              proseLintIssues.set(`${issue.kind}:${issue.detail}`, issue);
            }
            ingestComposedLine(r.raw, r.patch);
            emit(r.line + "\n");
          }
        }
        if (buffer.trim()) {
          const r = finalize(buffer);
          if (!r.skip) {
            ingestComposedLine(r.raw, r.patch);
            emit(r.line + "\n");
          }
        }

        if (investigatePlanDoc) {
          const prior = getCachedArtifacts(csvId);
          if (prior) cacheArtifacts(csvId, { ...prior, plan: investigatePlanDoc });
        }

        // Screened superlatives narrated without their raw extreme —
        // post-resolution narrative scan, same as Ask.
        for (const issue of lintSuperlativeHidesRaw(
          investigationFindings?.findings ?? [],
          narrativeTexts
        )) {
          proseLintIssues.set(`${issue.kind}:${issue.name ?? issue.detail}`, issue);
        }

        // Prose citing a finding the manifest doesn't declare — same
        // referent-integrity scan as Ask.
        for (const issue of lintDanglingFindingReference(
          narrativeTexts,
          investigationFindings?.findings ?? []
        )) {
          proseLintIssues.set(`${issue.kind}:${issue.name ?? issue.detail}`, issue);
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
          emit(JSON.stringify({ op: "add", path: "/state/__synthesis", value: synthesis }) + "\n");
        }

        // ── Grounding verdict ──
        // Verify the composed narrative against what the investigation
        // actually computed. Ungrounded figures (numbers that trace to no
        // computed value) are surfaced as an advisory caveat and recorded in
        // the trail — the guard against plausible-but-wrong, where semantic
        // validation only catches degenerate.
        if (!closed()) {
          const grounded = collectGroundedValues(mergedResults, mergedChartData);
          // Also ground against the per-step DATASETS. initialState carries
          // only results + chart_data, but an insight/brief narrative often
          // cites a figure straight from a step's data table (a per-industry
          // median, a top row's value) — which lives in datasets. Without
          // this, genuinely-computed numbers get a misleading "untraceable"
          // caveat. (Caught by the e2e harness: real median_revenue figures
          // 7.25M / 712.7M were falsely flagged.)
          for (const s of trace.steps) {
            if (s.datasets) {
              grounded.push(...collectGroundedValues({}, s.datasets as Record<string, unknown>));
            }
          }
          // Declared-findings values (CI bounds, p-values) are computed
          // results the compiled narrative binds directly — trace them.
          if (investigationFindings) {
            grounded.push(
              ...collectGroundedValues({}, {
                findings: investigationFindings.findings.map((f) => f.value),
              } as Record<string, unknown>)
            );
          }
          // The materialized row count (and, when capped, the sample size
          // WAREHOUSE_MAX_ROWS) is a legitimate provenance figure the narrative
          // may cite ("based on 1,000,000 rows") — a KNOWN value, not a
          // hallucination — so ground it to avoid a misleading "untraceable"
          // caveat on the data-scope sentence.
          if (stored?.schema?.row_count) grounded.push(stored.schema.row_count);
          if (materializationSampled) grounded.push(WAREHOUSE_MAX_ROWS);
          const grounding = verifyGrounding({
            narrativeTexts,
            citedSteps: [...citedSteps].sort((a, b) => a - b),
            grounded,
            successfulStepNos: successfulStepNos(trace),
            // String-carrier exemption: numerals inside bound string values
            // (payee names, identifiers) are data, not figures. Collected
            // across every step's results plus the merged findings.
            stringValues: [
              ...subResults.flatMap((r) =>
                collectStringLeaves(r.result?.executionResult.results ?? {})
              ),
              ...(investigationFindings
                ? collectStringLeaves(investigationFindings.findings.map((f) => f.value))
                : []),
            ],
            // §7.5: unnarrated findings + cross-step coherence, advisory.
            ...(fMode === "on" && investigationFindings
              ? {
                  findings: {
                    declared: investigationFindings.findings.map((f) => f.name),
                    cited: [...citedFindingNames],
                    issues: [
                      ...lintDerivations(investigationFindings.findings),
                      ...lintCrossStepReconciliation(investigationFindings.findings),
                      ...proseLintIssues.values(),
                    ].map((i) => i.detail),
                  },
                }
              : {}),
          });
          // The style this run was composed with (same stamp as the Ask
          // pipeline) — the header dropdown adopts it on restore.
          emit(
            JSON.stringify({
              op: "add",
              path: "/state/__purpose",
              value: context.purpose ?? "dashboard",
            }) + "\n"
          );
          // Verifiability panel (composer-sight spec §2) — investigate flavor.
          emit(
            JSON.stringify({
              op: "add",
              path: "/state/__verifiability",
              value: {
                composerSight: context.composer_sight === "sighted" ? "sighted" : "blind",
                findings: {
                  declared: investigationFindings?.findings.length ?? 0,
                  cited: citedFindingNames.size,
                  checks: (investigationFindings?.findings ?? []).filter((f) => f.dtype === "check")
                    .length,
                  failedChecks: (investigationFindings?.findings ?? [])
                    .filter(
                      (f) =>
                        f.dtype === "check" &&
                        f.value !== null &&
                        typeof f.value === "object" &&
                        (f.value as Record<string, unknown>).passed === false
                    )
                    .map((f) => f.name),
                },
                prose: {
                  issues: [...proseLintIssues.values()].slice(0, 32).map((i) => ({
                    kind: i.kind,
                    detail: i.detail,
                  })),
                },
                grounding: {
                  ok: grounding.ok,
                  checkedCount: grounding.checkedCount,
                  ungrounded: grounding.ungrounded,
                  contradictions: grounding.contradictions ?? [],
                },
              },
            }) + "\n"
          );
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
        const msg = errMessage(err);
        logger.error("Investigate: failed", {
          ...serializeError(err),
          error: msg.slice(0, 500),
        });
        // Persist the partial trail (per-step question/status/error/
        // code) into the run's diagnostics record — the epilogue in
        // `finally` writes it. Failed runs are the ones that most need
        // a post-mortem trail, and the in-memory artifacts cache only
        // gets a trace when the run completes (OBS-8).
        diagEvent("investigation_failed", {
          error: msg.slice(0, 500),
          partialSteps: trailRecorder?.partialTrail() ?? [],
          decisions: trailRecorder?.decisions ?? [],
        });
        emit(
          JSON.stringify({
            op: "add",
            path: "/state/__error",
            value: msg,
          }) + "\n"
        );
      } finally {
        // ── Cost/diagnostics epilogue: runs for every exit path (cheap
        // fast-path, main investigation, or error) before the stream
        // closes. Shared with Ask — lib/cost/epilogue.ts. ──
        await emitCostEpilogue({
          emit,
          datasetLabel,
          question,
          mode: analysisMode,
          purpose: context.purpose,
        });
      }
    })
  );
}
