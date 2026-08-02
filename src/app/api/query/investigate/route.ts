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
import { apiError } from "@/lib/api-error";
import { generatePlan } from "@/lib/llm/investigate-planner";
import {
  runInvestigation,
  deriveAnalysisWindow,
  type InvestigateProgressEvent,
} from "@/lib/pipeline/investigate-orchestrator";
import { runPipeline } from "@/lib/pipeline/orchestrator";
import { prewarmCodeGenCache } from "@/lib/llm/code-generation";
import { runWithCostTracking } from "@/lib/cost/accumulator";
import { emitCostEpilogue } from "@/lib/cost/epilogue";
import { runWithDiagnostics, diagEvent } from "@/lib/diagnostics/run-diagnostics";
import { composeAndStreamDashboard } from "@/lib/pipeline/dashboard-compose";
import { patchStreamResponse } from "@/lib/pipeline/patch-stream";
import { persistHistoryOnDisconnect } from "@/lib/history/persist-on-disconnect";
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
import { composeInvestigation } from "@/lib/llm/investigate-composer";
import { composeStepCell } from "@/lib/llm/step-cell-composer";
import { createSpecFinalizer, type SpecPatch } from "@/lib/llm/finalize-spec-stream";
import { cacheArtifacts, getCachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import {
  buildInvestigationTrace,
  successfulStepNos,
  TraceRecorder,
} from "@/lib/pipeline/investigation-trace";
import {
  collectGroundedValues,
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
import { prewarmSQLGenCache } from "@/lib/warehouse/sql-generation";
import { validateQueryIds, resolveQuerySources } from "@/lib/pipeline/validate-request";
import { readJsonBody, parseBody, analysisRequestSchema } from "@/lib/api-schemas";
import { getActiveProvider, providerCapabilities } from "@/lib/llm/client";
import { logger, serializeError } from "@/lib/logger";

export const maxDuration = 1260; // 21 min — investigations over large/remote datasets can run long

export async function POST(request: Request) {
  // Aborted duplicate requests truncate the body — a 400, not a logged 500.
  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  try {
    const parsed = parseBody(analysisRequestSchema, read.body);
    if (!parsed.ok) return parsed.response;
    const body = parsed.data;
    const context = body.context ?? {};

    // ── Shared preamble step 1: ids/question 400s (lib/pipeline/
    // validate-request.ts — same module Ask uses, so the two routes can't
    // drift again). The provider gate below sits between the syntactic 400s
    // and the resource 404s, preserving the route's check order. ──
    const ids = validateQueryIds(context, body.prompt);
    if (!ids.ok) return ids.response;
    const { warehouseId, question } = ids;
    let csvId = ids.csvId;

    // Investigate is a heavyweight cloud-LLM operation. Local backends are
    // gated at the UI level; refuse here as a safety net.
    let activeProvider: ReturnType<typeof getActiveProvider>;
    try {
      activeProvider = getActiveProvider();
    } catch (err) {
      return apiError("/api/query/investigate", err, "No LLM configured", 400);
    }
    // Capability lives in ONE place (providerCapabilities) — this route's
    // hand-maintained refusal list had drifted from Ask's validation list.
    if (!providerCapabilities(activeProvider).supportsInvestigate) {
      return new Response(
        JSON.stringify({
          error:
            "Investigate mode requires a cloud LLM provider (Anthropic, Bedrock, Vertex, or OpenAI-compatible). Local models plan and synthesize multi-step investigations poorly. Switch in Settings or use Ask instead.",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // ── Shared preamble step 2: warehouse/CSV 404s + model/runtime
    // resolution. Investigate skips the warehouse lookup when a csv_id
    // exists (follow-up over an already-materialized pull) and 404s a
    // missing CSV before streaming. ──
    const sources = resolveQuerySources(ids, context, {
      preferCsvOverWarehouse: true,
      requireStoredCsv: true,
    });
    if (!sources.ok) return sources.response;
    const { warehouseState, codeGenModel, uiComposeModel, sandboxRuntime } = sources;

    // Compose notebook cells eagerly only when the client is in Notebook view;
    // otherwise they're composed lazily on Notebook-open (cost optimization).
    const composeCells = context.compose_cells !== false;

    // ── Stream begins ── (scaffold shared with Ask — lib/pipeline/patch-stream.ts)
    let datasetLabel = csvId ?? warehouseId ?? "dataset";
    let analysisMode = "investigate";

    return patchStreamResponse(
      "/api/query/investigate",
      request,
      async (stream) => {
        const emit = stream.emit;
        const closed = () => stream.isClosed();
        const emitProgress = stream.emitProgress;
        // Make this run discoverable by a reconnecting client (run-stream-hub).
        stream.setMeta({ csvId: csvId ?? undefined, question });

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
              if (warehouseState) {
                const { warehouse, connector } = warehouseState;
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
                  const msg = err instanceof Error ? err.message : String(err);
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
                stream.setMeta({ csvId }); // warehouse csvId now known
                materializationSampled = storedResult.sampled;
                warehouseParquetFile = storedResult.parquetFile;
                warehouseParquetContext = storedResult.parquetContext;
              }

              // ── Resolve the source (file upload, local mount, or the CSV
              //     just materialized from the warehouse) ──
              const stored = getStoredCSV(csvId!);
              if (!stored) {
                throw new Error("CSV not found or expired");
              }
              datasetLabel = stored.schema.filename;
              const isLocal = isLocalFile(csvId!);
              const isRemote = isRemoteFile(csvId!);
              // In Parquet mode (local mount, materialized warehouse, or remote
              // URL) the analysis reads Parquet directly, so we never load the
              // (large) CSV into memory.
              const csvContent =
                isLocal || isRemote || warehouseParquetFile
                  ? ""
                  : ((await getCSVContent(csvId!)) ?? "");
              const geojsonContent = stored.schema.has_geojson
                ? await getGeoJSONContent(csvId!)
                : null;

              // Mount path + code-gen "Data Location" context. A materialized
              // warehouse pull was docker-cp'd to /data/input.parquet (no mount);
              // a browsed local file resolves via the shared resolver; a remote
              // cloud Parquet URL is read directly by DuckDB (no mount). Same
              // resolvers as /api/query.
              let localMountPath: string | undefined;
              let localFileContext: string | undefined;
              if (warehouseParquetFile) {
                localFileContext = warehouseParquetContext;
              } else if (isLocal) {
                ({ localMountPath, localFileContext } = resolveLocalSource(stored));
              } else if (isRemote) {
                ({ localFileContext } = resolveRemoteSource(
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
                const budgetKey = csvId ?? warehouseId ?? "default";
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
                // investigations leave these undefined and run Python over the shared CSV.
                warehouse: warehouseState?.warehouse.tableSchemas,
                warehouseType: warehouseState?.warehouse.config.type,
                materializationSQL: warehouseSQL,
                warehouseExecutor: warehouseState
                  ? (sql: string) => warehouseState!.connector.executeSQL(sql)
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
                  .map((s) => ({
                    stepNo: s.stepNo,
                    question: s.question,
                    reason: s.degradedReason,
                  })),
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
                  JSON.stringify({ op: "add", path: "/state/__dataQuality", value: dataQuality }) +
                    "\n"
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
                purpose: context.purpose,
                // Warehouse investigations cover the materialized pull's time
                // window; surface it so the dashboard states its scope.
                analysisWindow: warehouseState ? deriveAnalysisWindow(stored.schema) : undefined,
                // When the pull hit the row cap, the analysis is over a sample —
                // tell the composer to disclose it.
                sampleRows: materializationSampled ? WAREHOUSE_MAX_ROWS : undefined,
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
              };

              // Shared finalization stage (placeholder resolution + $state repair),
              // identical to Ask mode. Investigate inlines per-step data via
              // $chartData/$result, so no DataController $state repair is needed.
              const finalize = createSpecFinalizer({
                results: mergedResults,
                chartData: mergedChartData,
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
                    grounded.push(
                      ...collectGroundedValues({}, s.datasets as Record<string, unknown>)
                    );
                  }
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
                });
                trace.grounding = grounding; // shared ref — updates the cached entry
                if (
                  !grounding.ok ||
                  grounding.uncitedSuccessfulSteps.length > 0 ||
                  grounding.checkedCount > 0
                ) {
                  emit(
                    JSON.stringify({ op: "add", path: "/state/__grounding", value: grounding }) +
                      "\n"
                  );
                }
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
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
      },
      // Client disconnected mid-run → persist history server-side, same as Ask.
      // Investigate runs are longer (multi-step, 21-min budget) and therefore
      // MORE likely to hit a disconnect; previously only Ask had this and a
      // dropped investigation lost its entire (expensive) result.
      (stream) => persistHistoryOnDisconnect(stream, csvId, question)
    );
  } catch (err) {
    return apiError("/api/query/investigate", err, "Investigate failed");
  }
}
