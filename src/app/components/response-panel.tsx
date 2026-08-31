"use client";

import type { Spec } from "@/spec/react";
import { errMessage } from "@/lib/logger";
import { STORAGE_KEYS } from "@/lib/constants";
import { SpecView } from "@/components/spec-view";
import { CitationNavigateContext } from "@/components/registry-primitives";
import { logClient } from "@/app/lib/client-log";
import { resolveDrillValues, formatFilterValue, type ClickedRecord } from "@/lib/drill-resolve";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DrillDownParams } from "@/lib/contracts/spec-types";
import type { SchemaMode } from "@/lib/contracts/data-schema";
import type { CachedArtifacts } from "@/lib/contracts/investigation";
import type { TraceStep } from "@/lib/contracts/investigation";
import { getArtifacts, recomposeInvestigation } from "@/app/lib/api";
import { ArtifactsViewer } from "@/app/components/artifacts-viewer";
import { NotebookView, type NotebookExportApi } from "@/app/components/notebook-view";
import { SelectionDrillBar } from "@/app/components/selection-drill-bar";
import { readStreamState, type CostInfo } from "@/lib/contracts/stream-state";
import type { AnalysisRequestContext } from "@/lib/contracts/analysis-request";
import { ActionButton } from "@/components/ui/action-button";
import { Card } from "@/components/ui/card";
import {
  specHasInvestigation,
  buildInvestigateScope,
  type DrillLevel,
} from "@/app/components/spec-insights";
import { ViewModeToggle } from "@/app/components/view-mode-toggle";
import { useAnalysisStream } from "@/hooks/use-analysis-stream";
import {
  PipelineProgress,
  InvestigateProgress,
  InvestigationCaveats,
  SpinnerIcon,
} from "@/app/components/analysis-progress";
import { truncate } from "@/lib/format";

const VIEW_MODE_STORAGE_KEY = STORAGE_KEYS.investigateView;

/** Dashboard | Notebook segmented control for Investigate results. */
interface ResponsePanelProps {
  csvId: string | null;
  /** Multi-entity manifest context for the next question (spec §7). */
  manifestQuestion?: { manifest_id: string; entities: { name: string; csv_id: string }[] } | null;
  warehouseId?: string | null;
  question: string | null;
  questionSeq: number;
  /**
   * Which pipeline to use for the next stream:
   * - "ask" (default) → /api/query, single-shot
   * - "investigate" → /api/query/investigate, multi-step plan + execute + compose
   * The mode is captured at the moment the stream begins; switching after
   * the question is in flight has no effect until the next questionSeq tick.
   */
  mode?: "ask" | "investigate";
  onStreamEnd?: () => void;
  loadedSpec?: Spec | null;
  loadedArtifacts?: CachedArtifacts | null;
  schemaMode?: SchemaMode;
  composerSight?: string;
  verifiability?: import("@/app/components/verify-tab").VerifiabilityPayload | null;
  historyId?: string | null;
  purpose?: string;
  onRerun?: () => void;
  loadedVizId?: string | null;
  /** Page-owned artifacts state (single source — see M5-5e). */
  artifacts: CachedArtifacts | null;
  setArtifacts: (
    a: CachedArtifacts | null | ((prev: CachedArtifacts | null) => CachedArtifacts | null)
  ) => void;
  onEffectiveCsvIdChange?: (csvId: string | null) => void;
  onAnalysisComplete?: (entry: { question: string; spec: Spec }) => void;
  /** Per-analysis cost (from the streamed /state/__cost). Drives the footer. */
  onCost?: (cost: CostInfo) => void;
  /** Registers the active notebook's export handlers with the page Export
   *  menu (null when not in notebook view / no trail). */
  onNotebookExportApiChange?: (api: NotebookExportApi | null) => void;
  /**
   * When set alongside a fresh `questionSeq`, ResponsePanel calls /api/query
   * with this code in `context.code`. The server skips code-gen and runs the
   * sandbox-execute → UI-compose path, producing a fresh dashboard from the
   * edited code. Used by the Edit-and-Rerun feature.
   */
  rerunCode?: string | null;
  /**
   * When set, ResponsePanel sends `context.sql` so the server skips NL-to-SQL
   * generation (warehouse sources only). Used by SQL Edit-and-Rerun.
   */
  rerunSql?: string | null;
  /**
   * When set alongside a fresh `questionSeq`, ResponsePanel REATTACHES to an
   * already-running server-side analysis (POST /api/query/attach with this
   * runId) instead of starting a new one — replaying its progress so far, then
   * streaming to completion. Used to recover a run whose live view was lost to
   * a reload / HMR (see run-stream-hub, useActiveRuns).
   */
  reattachRunId?: string | null;
  /**
   * Called when a reattach produced no renderable result — the run had been
   * stopped / its channel raced closed / its buffer was incomplete, so replaying
   * it would leave a blank page. The parent re-runs the question fresh instead.
   */
  onReattachFailed?: () => void;
}

export function ResponsePanel({
  csvId,
  manifestQuestion,
  warehouseId,
  question,
  questionSeq,
  mode = "ask",
  onStreamEnd,
  loadedSpec,
  loadedArtifacts,
  schemaMode = "metadata",
  composerSight,
  verifiability,
  historyId,
  purpose = "dashboard",
  onRerun,
  loadedVizId,
  artifacts,
  setArtifacts,
  onEffectiveCsvIdChange,
  onAnalysisComplete,
  onCost,
  onNotebookExportApiChange,
  rerunCode,
  rerunSql,
  reattachRunId,
  onReattachFailed,
}: ResponsePanelProps) {
  const [drillStack, setDrillStack] = useState<DrillLevel[]>([]);
  // Dashboard | Notebook view for Investigate results. Initialized from
  // localStorage in an effect (not the initializer) to avoid an SSR
  // hydration mismatch.
  const [viewMode, setViewMode] = useState<"dashboard" | "notebook">("dashboard");
  useEffect(() => {
    if (localStorage.getItem(VIEW_MODE_STORAGE_KEY) === "notebook") {
      setViewMode("notebook");
    }
  }, []);
  const handleViewModeChange = useCallback((v: "dashboard" | "notebook") => {
    setViewMode(v);
    try {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, v);
    } catch {
      // Storage unavailable (private mode) — the toggle still works for the session.
    }
  }, []);
  // Citation click-through: clicking a "(Step N)" superscript anywhere in an
  // Investigate result jumps to that step's notebook cell. `seq` makes
  // repeat clicks on the same citation re-trigger the scroll.
  const [citationTarget, setCitationTarget] = useState<{ stepNo: number; seq: number } | null>(
    null
  );
  const navigateToCell = useCallback(
    (stepNo: number) => {
      handleViewModeChange("notebook");
      setCitationTarget((prev) => ({ stepNo, seq: (prev?.seq ?? 0) + 1 }));
    },
    [handleViewModeChange]
  );
  // True once any step has been re-run from the notebook: the composed
  // dashboard still reflects the ORIGINAL run (v1 does not recompose it).
  const [dashboardStale, setDashboardStale] = useState(false);
  // Stream lifecycle extracted to useAnalysisStream (M5-5d): endpoint
  // selection, request building, the seq latch, StrictMode-safe reattach,
  // and the stream's three spec holders live in the hook — the panel keeps
  // presentation/restore state and supplies reset + completion callbacks.
  const {
    spec,
    isStreaming,
    error,
    send,
    clear,
    previousSpec,
    setPreviousSpec,
    currentSpecRef,
    currentQuestionRef,
    liveRunIdRef,
  } = useAnalysisStream({
    mode,
    questionSeq,
    question,
    csvId,
    manifestQuestion,
    warehouseId,
    historyId,
    reattachRunId,
    schemaMode,
    composerSight,
    purpose,
    rerunCode,
    rerunSql,
    // Only eager-compose notebook cells if the user is already in Notebook
    // view; otherwise they're composed lazily on Notebook-open.
    composeCells: viewMode === "notebook",
    onStreamStarting: () => {
      // Reset drill stack and stale artifacts/flags on a new question.
      setDrillStack([]);
      setArtifacts(null);
      setShowArtifacts(false);
      setDashboardStale(false);
      setRecomposeError(null);
      setCitationTarget(null);
    },
    onCompleted: (completedSpec, q) => onAnalysisComplete?.({ question: q, spec: completedSpec }),
    onCost,
    onStreamEnd,
    onReattachFailed,
  });

  // For warehouse queries, the csvId is generated server-side and emitted in the stream
  const warehouseCsvId = readStreamState(spec).__warehouse_csv_id;
  const effectiveCsvId = csvId ?? warehouseCsvId ?? null;

  // Artifacts DATA is owned by the page (M5-5e — one useArtifacts instance
  // app-wide): the side panel, the inline viewer, and notebook step-re-run
  // merges all read/write the same state, so the Trail can never diverge
  // again. Only the inline-viewer visibility is panel-local UI state.
  const [showArtifacts, setShowArtifacts] = useState(false);

  // Diagnostics for the mid-stream abort: track when a stream is live so the
  // unmount cleanup can report it (fed from the hook's isStreaming below).
  const streamStartedAtRef = useRef<number | null>(null);
  const streamingRef = useRef(false);

  // Drill-down handler — passed to <SpecView onDrillDown>; SpecView supplies
  // the clicked mark's dimension values from its per-instance click context
  // (M5-5b: this replaced the two module-level refs that limited the app to
  // one mounted panel).
  const handleDrillDown = useCallback(
    (params: DrillDownParams, clicked: ClickedRecord) => {
      // Use effectiveCsvId (csvId ?? warehouseCsvId) so warehouse-sourced
      // investigations can drill too — the raw csvId is null for those.
      if (!currentSpecRef.current || (!effectiveCsvId && !warehouseId)) return;

      // Charts aren't json-render list/repeater contexts, so the composer's
      // {"$item": ...} drill bindings arrive unresolved. Resolve them against
      // the dimension values the chart captured on click.
      const resolved = resolveDrillValues(params, clicked);
      // Value-less click on a bound chart, or a binding with nothing captured
      // — nothing meaningful to drill into.
      if (!resolved) return;
      const { filterValue, segmentLabel, additionalFilters: resolvedAdditional } = resolved;

      const currentQuestion = currentQuestionRef.current ?? "Analysis";
      // Deep-clone the spec so later stream mutations don't corrupt the snapshot
      const snapshotSpec = JSON.parse(JSON.stringify(currentSpecRef.current!));
      setDrillStack((prev) => [
        ...prev,
        {
          question: currentQuestion,
          segmentLabel,
          spec: snapshotSpec,
        },
      ]);

      const additionalFilters = resolvedAdditional;
      // Multi-select values read "col in (a, b)"; single values "col = v".
      const describeFilter = (column: string, value: typeof filterValue) =>
        Array.isArray(value)
          ? `${column} in (${formatFilterValue(value)})`
          : `${column} = ${value}`;
      const filterDesc = [
        describeFilter(params.filter_column, filterValue),
        ...additionalFilters.map((f) => describeFilter(f.column, f.value)),
      ].join(", ");
      // Neutral phrasing — the depth (quick lookup vs. scoped sub-investigation)
      // is decided by the classifier on the investigate route, not pre-biased by
      // wording like "analyze in detail".
      const drillQuestion = `Analyze the "${segmentLabel}" segment (${filterDesc})`;
      currentQuestionRef.current = drillQuestion;

      // Drill-as-sub-investigation: when drilling a chart on an Investigate
      // result, route the segment through a scoped Investigate (the segment
      // filters + the parent plan become the planner's scope). On an Ask
      // result this is undefined and the existing drill_down_context path runs.
      const drillFilters = [
        { column: params.filter_column, value: filterValue },
        ...additionalFilters,
      ];
      const drillScope = specHasInvestigation(snapshotSpec as Spec)
        ? buildInvestigateScope(snapshotSpec as Spec, {
            parentQuestion: currentQuestion,
            filters: drillFilters,
            segmentLabel,
          })
        : undefined;
      currentSpecRef.current = null;

      send("", {
        csv_id: effectiveCsvId ?? undefined,
        warehouse_id: warehouseId ?? undefined,
        history_id: historyId ?? undefined,
        question: drillQuestion,
        drill_down_context: {
          parent_question: currentQuestion,
          filter_column: params.filter_column,
          filter_value: filterValue,
          segment_label: segmentLabel,
          chart_title: params.chart_title,
          additional_filters: additionalFilters.length > 0 ? additionalFilters : undefined,
        },
        scope: drillScope,
        compose_cells: viewMode === "notebook",
        schema_mode: schemaMode,
        // Model/runtime deliberately NOT sent — golden source (runtime-config).
        purpose,
      } satisfies AnalysisRequestContext);
    },
    // Full dep list: the callback SENDS schemaMode / models / runtime /
    // purpose / viewMode — the old ref-assignment effect once listed only
    // three deps behind a disable, so changed settings drilled stale.
    [
      effectiveCsvId,
      warehouseId,
      historyId,
      send,
      currentSpecRef,
      currentQuestionRef,
      schemaMode,
      purpose,
      viewMode,
    ]
  );

  // Track live-stream state for the abort diagnostics above.
  useEffect(() => {
    streamingRef.current = isStreaming;
    if (isStreaming && streamStartedAtRef.current === null) streamStartedAtRef.current = Date.now();
    if (!isStreaming) streamStartedAtRef.current = null;
  }, [isStreaming]);

  // If this panel unmounts WHILE a stream is live, that unmount is what aborts the
  // query ("network error"). Log it loudly so the trigger can be pinned down.
  useEffect(() => {
    return () => {
      if (streamingRef.current) {
        // logClient (keepalive fetch) so this reaches the SERVER log even as
        // the page tears down — the browser console alone was lost unless
        // devtools were open at the moment of failure.
        logClient(
          "warn",
          "[ResponsePanel] UNMOUNTED WHILE STREAMING — aborts the in-flight query",
          {
            elapsedMs: streamStartedAtRef.current ? Date.now() - streamStartedAtRef.current : null,
          },
          liveRunIdRef.current ?? undefined
        );
      }
    };
  }, []);

  const handleClear = useCallback(() => {
    clear();
    setDrillStack([]);
    currentSpecRef.current = null;
    setPreviousSpec(null);
  }, [clear, currentSpecRef, setPreviousSpec]);

  // Restored spec for drill-back or loaded viz
  const [restoredSpec, setRestoredSpec] = useState<Spec | null>(null);

  // When loadedSpec changes, treat it as a restored spec
  useEffect(() => {
    if (loadedSpec) {
      currentSpecRef.current = loadedSpec;
      setRestoredSpec(loadedSpec);
      setDrillStack([]);
      setPreviousSpec(null);
      // Seed artifacts from saved viz (if available)
      setArtifacts(loadedArtifacts ?? null);
      setShowArtifacts(false);
    } else {
      // loadedSpec cleared (e.g., loading a new viz) — clear stale display
      setRestoredSpec(null);
      currentSpecRef.current = null;
    }
  }, [
    loadedSpec,
    loadedArtifacts,
    setArtifacts,
    setShowArtifacts,
    currentSpecRef,
    setPreviousSpec,
  ]);

  // Report effectiveCsvId to parent (needed for page-level artifacts panel)
  useEffect(() => {
    onEffectiveCsvIdChange?.(effectiveCsvId);
  }, [effectiveCsvId, onEffectiveCsvIdChange]);

  const handleBackWithRestore = useCallback(
    (toIndex: number) => {
      const targetLevel = drillStack[toIndex];
      const newStack = drillStack.slice(0, toIndex);
      setDrillStack(newStack);
      currentSpecRef.current = targetLevel.spec;
      currentQuestionRef.current = targetLevel.question;
      clear();
      setRestoredSpec(targetLevel.spec);
    },
    [drillStack, clear, currentSpecRef, currentQuestionRef]
  );

  // When a new stream starts, clear restored spec
  useEffect(() => {
    if (isStreaming) {
      setRestoredSpec(null);
    }
  }, [isStreaming]);

  // restoredSpec takes priority when set (user clicked Restore or loaded a viz).
  // spec from useUIStream only takes over during/after a new stream.
  const activeSpec = restoredSpec ?? spec;

  // Notebook mode: available for Investigate results (the spec carries
  // __plan from the first planning patch, so the toggle appears early in
  // the stream). Drilled specs are plain dashboards — no __plan, no toggle.
  const notebookAvailable =
    specHasInvestigation(activeSpec) || (isStreaming && mode === "investigate");
  const notebookActive = notebookAvailable && viewMode === "notebook";

  // After a notebook step re-run: merge the fresh step into our artifacts
  // copy (so the artifacts panel's Trail agrees) and flag the dashboard —
  // it was composed from the original results and is not recomposed in v1.
  const handleStepRerun = useCallback(
    (step: TraceStep) => {
      setDashboardStale(true);
      setArtifacts((prev) => {
        if (!prev?.investigation) return prev;
        return {
          ...prev,
          investigation: {
            ...prev.investigation,
            steps: prev.investigation.steps.map((s) => (s.index === step.index ? step : s)),
          },
        };
      });
    },
    [setArtifacts]
  );

  // Recompose the dashboard from the (re-run) trail so the Dashboard view
  // reflects current step results instead of just showing a stale banner.
  const [recomposing, setRecomposing] = useState(false);
  const [recomposeError, setRecomposeError] = useState<string | null>(null);
  const handleRecompose = useCallback(async () => {
    if (!effectiveCsvId) return;
    setRecomposing(true);
    setRecomposeError(null);
    try {
      const { spec: newSpec } = await recomposeInvestigation(effectiveCsvId);
      currentSpecRef.current = newSpec;
      setRestoredSpec(newSpec);
      setDashboardStale(false);
    } catch (err) {
      setRecomposeError(errMessage(err));
    } finally {
      setRecomposing(false);
    }
  }, [effectiveCsvId, currentSpecRef]);

  // The notebook's code/data disclosures come from the audit trail in the
  // cached artifacts — fetch them quietly once the stream ends. Failure is
  // non-fatal: the notebook still renders cells from spec state.
  useEffect(() => {
    if (!notebookActive || isStreaming || !effectiveCsvId || artifacts) return;
    let cancelled = false;
    getArtifacts(effectiveCsvId)
      .then((data) => {
        if (!cancelled) setArtifacts(data);
      })
      .catch(() => {
        // Artifacts expired — notebook renders from spec state alone.
      });
    return () => {
      cancelled = true;
    };
  }, [notebookActive, isStreaming, effectiveCsvId, artifacts, setArtifacts]);

  if (error) {
    return (
      <div
        className="border border-error-border bg-error-bg p-6"
        style={{ borderRadius: "var(--radius-card)" }}
      >
        <p className="font-medium text-error-text">Analysis Error</p>
        <p className="mt-1 text-sm text-error-text opacity-85">{error.message}</p>
        <button
          onClick={handleClear}
          className="mt-3 text-sm font-medium text-error-text underline hover:no-underline"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!activeSpec && !isStreaming && !previousSpec) {
    // During the brief gap between mount and first stream chunk, show a loading state
    // instead of returning null (which causes a blank screen flash)
    if (questionSeq > 0) {
      return (
        <div
          className="flex items-center gap-2 text-sm text-accent"
          role="status"
          aria-live="polite"
        >
          <SpinnerIcon />
          Starting analysis...
        </div>
      );
    }
    return null;
  }

  return (
    <div className="space-y-4">
      {/* Breadcrumb navigation */}
      {drillStack.length > 0 && (
        <nav className="flex items-center gap-1 text-sm">
          <button
            onClick={() => handleBackWithRestore(0)}
            className="text-accent hover:text-accent-hover transition-colors"
            style={{ transitionDuration: "var(--transition-speed)" }}
          >
            {truncate(drillStack[0].question, 40)}
          </button>
          {drillStack.slice(1).map((level, i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="text-t-tertiary">/</span>
              <button
                onClick={() => handleBackWithRestore(i + 1)}
                className="text-accent hover:text-accent-hover transition-colors"
                style={{ transitionDuration: "var(--transition-speed)" }}
              >
                {level.segmentLabel}
              </button>
            </span>
          ))}
          <span className="text-t-tertiary">/</span>
          <span className="font-medium text-t-secondary">
            {drillStack[drillStack.length - 1].segmentLabel}
          </span>
        </nav>
      )}

      {/* Collapsed previous levels (drill-down) */}
      {drillStack.length > 0 && (
        <div className="space-y-2">
          {drillStack.map((level, i) => (
            <div
              key={i}
              className="theme-card max-h-24 overflow-hidden border border-border-default opacity-50"
              style={{
                background: "var(--bg-panel)",
                borderRadius: "var(--radius-card)",
                padding: "var(--padding-card)",
              }}
            >
              <p className="mb-2 text-xs font-medium text-t-secondary">{level.question}</p>
              {level.spec?.root && level.spec?.elements && (
                <SpecView spec={level.spec} citations={specHasInvestigation(level.spec)} />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Dashboard | Notebook toggle for Investigate results */}
      {notebookAvailable && drillStack.length === 0 && (
        <div className="flex justify-end">
          <ViewModeToggle value={viewMode} onChange={handleViewModeChange} />
        </div>
      )}

      {/* Streaming indicator — the notebook renders its own live cells.
          `showProgress` also covers a REATTACH to a live run: the attach stream
          delivers valid progress patches but `isStreaming` can read false between
          the buffer replay and the live tail, which would otherwise leave a blank
          screen even though the run is still executing. While a reattach is
          pending (reattachRunId set, no dashboard yet), keep the progress up. */}
      {(() => {
        const showProgress = isStreaming || (!!reattachRunId && !activeSpec?.root);
        return notebookActive && showProgress ? null : showProgress && mode === "investigate" ? (
          <InvestigateProgress spec={activeSpec} />
        ) : showProgress ? (
          <PipelineProgress spec={activeSpec} drillStack={drillStack} previousSpec={previousSpec} />
        ) : null;
      })()}

      {/* Data-quality + grounding caveats for an Investigate result. Rendered
          above the dashboard so degraded/failed/dropped branches and any
          ungrounded figures are surfaced in the narrative, not buried. */}
      {activeSpec?.root && <InvestigationCaveats spec={activeSpec} />}

      {/* Active level: notebook view (Investigate) or composed dashboard.
          `formKey` keys the Card so the morph-in animation replays whenever
          the FORM changes — a new query (incl. a style switch that re-asks)
          or a Dashboard↔Notebook toggle — making the re-shape visible. */}
      <CitationNavigateContext.Provider value={notebookAvailable ? navigateToCell : null}>
        {notebookActive ? (
          <Card key={`nb-${questionSeq}`} className="form-morph">
            <NotebookView
              spec={activeSpec}
              artifacts={artifacts}
              isStreaming={isStreaming}
              scrollTarget={citationTarget}
              csvId={effectiveCsvId}
              onStepRerun={handleStepRerun}
              onExportApiChange={onNotebookExportApiChange}
            />
          </Card>
        ) : (
          activeSpec?.root &&
          activeSpec?.elements && (
            <Card key={`db-${questionSeq}`} className="form-morph">
              {dashboardStale && (
                <div
                  className="mb-3 flex items-center justify-between gap-2 border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-text"
                  style={{ borderRadius: "var(--radius-card)" }}
                >
                  <span>Step results changed since this dashboard was composed.</span>
                  <button
                    onClick={handleRecompose}
                    disabled={recomposing}
                    className="shrink-0 font-medium underline hover:no-underline disabled:opacity-50"
                  >
                    {recomposing ? "Recomposing…" : "Recompose dashboard"}
                  </button>
                </div>
              )}
              {recomposeError && (
                <div
                  className="mb-3 border border-error-border bg-error-bg px-3 py-2 text-xs text-error-text"
                  style={{ borderRadius: "var(--radius-card)" }}
                >
                  Recompose failed: {recomposeError}
                </div>
              )}
              {/* data-slides-root (via slidesRoot): the Slides export segments
                  this content into per-section deck slides. */}
              <SpecView
                spec={activeSpec}
                citations={specHasInvestigation(activeSpec)}
                loading={isStreaming}
                onDrillDown={handleDrillDown}
                toolbar={<SelectionDrillBar />}
                slidesRoot
              />

              {/* Save/Export/Artifacts actions moved to top bar — see page.tsx */}
            </Card>
          )
        )}
      </CitationNavigateContext.Provider>

      {/* Artifacts viewer */}
      {showArtifacts && artifacts && (
        <ArtifactsViewer
          artifacts={artifacts}
          verifiability={verifiability}
          historyId={historyId}
        />
      )}

      {/* Previous spec shown dimmed below the new dashboard during follow-ups */}
      {previousSpec?.root && previousSpec?.elements && isStreaming && (
        <Card className="opacity-40">
          <SpecView spec={previousSpec} citations={specHasInvestigation(previousSpec)} />
        </Card>
      )}
    </div>
  );
}
