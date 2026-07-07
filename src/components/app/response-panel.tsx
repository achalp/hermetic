"use client";

import {
  useUIStream,
  Renderer,
  StateProvider,
  ActionProvider,
  VisibilityProvider,
} from "@json-render/react";
import type { Spec } from "@json-render/react";
import { registry, registryActionHandlers } from "@/components/registry";
import { CitationsContext, CitationNavigateContext } from "@/components/registry-primitives";
import { drillDownCallbackRef, drillClickValueRef } from "@/lib/drill-down-context";
import { logClient } from "@/lib/client-log";
import { resolveDrillValues, formatFilterValue } from "@/lib/drill-resolve";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DrillDownParams, SchemaMode, FilterValue } from "@/lib/types";
import type { ModelId, SandboxRuntimeId } from "@/lib/constants";
import type { CachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import type { TraceStep } from "@/lib/pipeline/investigation-trace";
import type { InvestigateScope } from "@/lib/llm/investigate-planner";
import { useSaveExport } from "@/hooks/use-save-export";
import { useArtifacts } from "@/hooks/use-artifacts";
import { getArtifacts, recomposeInvestigation } from "@/lib/api";
import { ArtifactsViewer } from "@/components/app/artifacts-viewer";
import { NotebookView, type NotebookExportApi } from "@/components/app/notebook-view";
import { SelectionDrillBar } from "@/components/app/selection-drill-bar";
import type { CostInfo } from "@/components/app/cost-footer";
import { RendererErrorBoundary } from "@/components/app/renderer-error-boundary";
import { ActionButton } from "@/components/ui/action-button";
import { Card } from "@/components/ui/card";

interface DrillLevel {
  question: string;
  segmentLabel: string;
  spec: Spec;
}

/**
 * Specs produced by Investigate carry `__plan` in their state. Used to gate
 * Investigate-only rendering conventions (step-citation superscripts) so
 * Ask-mode prose is rendered verbatim.
 */
function specHasInvestigation(spec: Spec | null | undefined): boolean {
  return Boolean(spec?.state && "__plan" in (spec.state as Record<string, unknown>));
}

/**
 * Build the scoped-follow-up context for an Investigate, from the prior
 * investigation's `__plan` (approach + the sub-questions it already explored)
 * plus any drilled-segment filters. Drives drill-as-sub-investigation: the new
 * plan goes deeper instead of repeating the parent. Returns undefined when
 * there's nothing to scope (no prior plan and no filters).
 */
function buildInvestigateScope(
  spec: Spec | null | undefined,
  extra?: {
    parentQuestion?: string;
    filters?: { column: string; value: FilterValue }[];
    segmentLabel?: string;
  }
): InvestigateScope | undefined {
  const plan = (spec?.state as Record<string, unknown> | undefined)?.__plan as
    | { approach?: string; steps?: { question?: string }[] }
    | undefined;
  const hasPlan = !!plan && typeof plan === "object";
  if (!hasPlan && !extra?.filters?.length) return undefined;
  return {
    parent_question: extra?.parentQuestion,
    prior_approach: hasPlan ? plan!.approach : undefined,
    prior_steps:
      hasPlan && Array.isArray(plan!.steps)
        ? plan!.steps.map((s) => s.question).filter((q): q is string => !!q)
        : undefined,
    filters: extra?.filters,
    segment_label: extra?.segmentLabel,
  };
}

const VIEW_MODE_STORAGE_KEY = "hermetic-investigate-view";

/** Dashboard | Notebook segmented control for Investigate results. */
function ViewModeToggle({
  value,
  onChange,
}: {
  value: "dashboard" | "notebook";
  onChange: (v: "dashboard" | "notebook") => void;
}) {
  return (
    <div
      className="inline-flex overflow-hidden border border-border-default"
      style={{ borderRadius: "var(--radius-badge)" }}
      role="tablist"
      aria-label="Result view"
    >
      {(["dashboard", "notebook"] as const).map((v) => (
        <button
          key={v}
          role="tab"
          aria-selected={value === v}
          onClick={() => onChange(v)}
          className={`px-3 py-1 text-xs font-medium transition-colors ${
            value === v ? "bg-accent-subtle text-accent" : "text-t-secondary hover:text-t-primary"
          }`}
          style={{ transitionDuration: "var(--transition-speed)" }}
        >
          {v === "dashboard" ? "Dashboard" : "Notebook"}
        </button>
      ))}
    </div>
  );
}

interface ResponsePanelProps {
  csvId: string | null;
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
  onSaved?: () => void;
  schemaMode?: SchemaMode;
  codeGenModel?: ModelId;
  uiComposeModel?: ModelId;
  sandboxRuntime?: SandboxRuntimeId;
  purpose?: string;
  onRerun?: () => void;
  loadedVizId?: string | null;
  onArtifactsChange?: (artifacts: CachedArtifacts | null) => void;
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
}

export function ResponsePanel({
  csvId,
  warehouseId,
  question,
  questionSeq,
  mode = "ask",
  onStreamEnd,
  loadedSpec,
  loadedArtifacts,
  onSaved,
  schemaMode = "metadata",
  codeGenModel,
  uiComposeModel,
  sandboxRuntime,
  purpose = "dashboard",
  onRerun,
  loadedVizId,
  onArtifactsChange,
  onEffectiveCsvIdChange,
  onAnalysisComplete,
  onCost,
  onNotebookExportApiChange,
  rerunCode,
  rerunSql,
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
  const currentSpecRef = useRef<Spec | null>(null);
  const currentQuestionRef = useRef<string | null>(question);
  // Conversation history is now managed server-side via the conversation cache.
  const [previousSpec, setPreviousSpec] = useState<Spec | null>(null);
  const lastSeqRef = useRef(0);
  const dashboardRef = useRef<HTMLDivElement>(null);

  // Route the next stream to the right pipeline. The hook reads `api` per
  // call inside its useCallback, so toggling here before a new questionSeq
  // is enough — no remount required.
  const apiUrl = mode === "investigate" ? "/api/query/investigate" : "/api/query";

  // Diagnostics for the mid-stream abort: useUIStream aborts its fetch when this
  // panel unmounts, so a long query dies if anything tears the panel down. Track
  // when a stream is live so onError + the unmount cleanup can report it.
  const streamStartedAtRef = useRef<number | null>(null);
  const streamingRef = useRef(false);

  const { spec, isStreaming, error, send, clear } = useUIStream({
    api: apiUrl,
    onComplete: (completedSpec) => {
      currentSpecRef.current = completedSpec;
      setPreviousSpec(null);
      onStreamEnd?.();
      const cost = (completedSpec?.state as Record<string, unknown> | undefined)?.__cost as
        | CostInfo
        | undefined;
      if (cost) onCost?.(cost);
      if (completedSpec?.root && currentQuestionRef.current) {
        onAnalysisComplete?.({
          question: currentQuestionRef.current,
          spec: JSON.parse(JSON.stringify(completedSpec)),
        });
      }
    },
    onError: (err) => {
      // Diagnostic: a mid-stream error is almost always an abort from this panel
      // unmounting (useUIStream aborts its fetch on unmount). Log it with elapsed
      // time so we can correlate with what re-rendered/unmounted the panel.
      const elapsed = streamStartedAtRef.current ? Date.now() - streamStartedAtRef.current : null;
      logClient("warn", "[ResponsePanel] stream error", {
        elapsedMs: elapsed,
        name: (err as { name?: string })?.name,
        message: (err as { message?: string })?.message,
      });
      setPreviousSpec(null);
      onStreamEnd?.();
    },
  });

  // For warehouse queries, the csvId is generated server-side and emitted in the stream
  const warehouseCsvId = (spec?.state as Record<string, unknown> | undefined)
    ?.__warehouse_csv_id as string | undefined;
  const effectiveCsvId = csvId ?? warehouseCsvId ?? null;

  const {
    showArtifacts,
    setShowArtifacts,
    artifacts,
    setArtifacts,
    artifactsLoading,
    artifactsError,
    handleToggleArtifacts,
  } = useArtifacts({ csvId: effectiveCsvId });

  const {
    saving,
    saveMessage,
    exporting,
    handleSave,
    handleExportPdf,
    handleExportDocx,
    handleExportPptx,
  } = useSaveExport({
    csvId: effectiveCsvId,
    currentSpecRef,
    currentQuestionRef,
    dashboardRef,
    onSaved,
  });

  // Keep current question in sync
  useEffect(() => {
    currentQuestionRef.current = question;
  }, [question]);

  // Watch questionSeq changes to trigger initial queries and follow-ups
  useEffect(() => {
    if (questionSeq === 0 || questionSeq === lastSeqRef.current) return;
    lastSeqRef.current = questionSeq;

    if ((!csvId && !warehouseId) || !question) return;

    // Capture the prior result's investigation plan BEFORE it's cleared below.
    // A follow-up asked in Investigate mode on an Investigate result becomes a
    // scoped sub-investigation: the planner sees what the parent already
    // explored and goes deeper instead of repeating it (drill-as-sub-
    // investigation). No scope on a first question or an Ask-mode follow-up.
    const followUpScope =
      mode === "investigate" ? buildInvestigateScope(currentSpecRef.current) : undefined;

    // Show previous spec dimmed while streaming
    if (currentSpecRef.current) {
      setPreviousSpec(currentSpecRef.current);
    }

    // Reset drill stack and stale artifacts on follow-up
    setDrillStack([]);
    currentSpecRef.current = null;
    setArtifacts(null);
    setShowArtifacts(false);
    setDashboardStale(false);
    setRecomposeError(null);
    setCitationTarget(null);

    // Conversation history is managed server-side (keyed by csvId)
    send("", {
      csv_id: csvId,
      warehouse_id: warehouseId ?? undefined,
      question: question,
      schema_mode: schemaMode,
      code_gen_model: codeGenModel,
      ui_compose_model: uiComposeModel,
      sandbox_runtime: sandboxRuntime,
      purpose,
      // When set, the server uses these instead of generating fresh code/SQL.
      // Used for Edit-and-Rerun: rebuild dashboard from edited Python and/or SQL.
      code: rerunCode ?? undefined,
      sql: rerunSql ?? undefined,
      // Scoped follow-up on a prior Investigate (consumed by the investigate route).
      scope: followUpScope,
      // Only eager-compose notebook cells if the user is already in Notebook
      // view; otherwise they're composed lazily on Notebook-open (saves N
      // compose calls for the common Dashboard path). Investigate route only.
      compose_cells: viewMode === "notebook",
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionSeq]);

  // Set up drill-down callback ref
  useEffect(() => {
    drillDownCallbackRef.current = (params: DrillDownParams) => {
      // Use effectiveCsvId (csvId ?? warehouseCsvId) so warehouse-sourced
      // investigations can drill too — the raw csvId is null for those.
      if (!currentSpecRef.current || (!effectiveCsvId && !warehouseId)) return;

      // Charts aren't json-render list/repeater contexts, so the composer's
      // {"$item": ...} drill bindings arrive unresolved. Resolve them against
      // the dimension values the chart captured on click (drillClickValueRef).
      const clicked = drillClickValueRef.current;
      drillClickValueRef.current = null;
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
        csv_id: effectiveCsvId,
        warehouse_id: warehouseId ?? undefined,
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
        code_gen_model: codeGenModel,
        ui_compose_model: uiComposeModel,
        sandbox_runtime: sandboxRuntime,
        purpose,
      });
    };

    return () => {
      drillDownCallbackRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveCsvId, warehouseId, send]);

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
          }
        );
      }
    };
  }, []);

  const handleClear = useCallback(() => {
    clear();
    setDrillStack([]);
    currentSpecRef.current = null;
    setPreviousSpec(null);
  }, [clear]);

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
  }, [loadedSpec, loadedArtifacts, setArtifacts, setShowArtifacts]);

  // Notify parent when artifacts change
  useEffect(() => {
    onArtifactsChange?.(artifacts);
  }, [artifacts, onArtifactsChange]);

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
    [drillStack, clear]
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
      setRecomposeError(err instanceof Error ? err.message : String(err));
    } finally {
      setRecomposing(false);
    }
  }, [effectiveCsvId]);

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
                <CitationsContext.Provider value={specHasInvestigation(level.spec)}>
                  <StateProvider initialState={level.spec.state ?? {}}>
                    <ActionProvider handlers={registryActionHandlers}>
                      <VisibilityProvider>
                        <RendererErrorBoundary>
                          <Renderer spec={level.spec} registry={registry} />
                        </RendererErrorBoundary>
                      </VisibilityProvider>
                    </ActionProvider>
                  </StateProvider>
                </CitationsContext.Provider>
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

      {/* Streaming indicator — the notebook renders its own live cells */}
      {notebookActive && isStreaming ? null : isStreaming && mode === "investigate" ? (
        <InvestigateProgress spec={activeSpec} />
      ) : isStreaming ? (
        <PipelineProgress spec={activeSpec} drillStack={drillStack} previousSpec={previousSpec} />
      ) : null}

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
          <Card key={`nb-${questionSeq}`} ref={dashboardRef} className="form-morph">
            <NotebookView
              spec={activeSpec}
              artifacts={artifacts}
              isStreaming={isStreaming}
              scrollTarget={citationTarget}
              csvId={effectiveCsvId}
              sandboxRuntime={sandboxRuntime}
              onStepRerun={handleStepRerun}
              onExportApiChange={onNotebookExportApiChange}
            />
          </Card>
        ) : (
          activeSpec?.root &&
          activeSpec?.elements && (
            <Card key={`db-${questionSeq}`} ref={dashboardRef} className="form-morph">
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
              <CitationsContext.Provider value={specHasInvestigation(activeSpec)}>
                <StateProvider initialState={activeSpec.state ?? {}}>
                  <SelectionDrillBar />
                  <ActionProvider handlers={registryActionHandlers}>
                    <VisibilityProvider>
                      <RendererErrorBoundary>
                        {/* data-slides-root: the Slides export segments this
                            content into per-section deck slides. */}
                        <div data-slides-root>
                          <Renderer spec={activeSpec} registry={registry} loading={isStreaming} />
                        </div>
                      </RendererErrorBoundary>
                    </VisibilityProvider>
                  </ActionProvider>
                </StateProvider>
              </CitationsContext.Provider>

              {/* Save/Export/Artifacts actions moved to top bar — see page.tsx */}
            </Card>
          )
        )}
      </CitationNavigateContext.Provider>

      {/* Artifacts viewer */}
      {showArtifacts && artifacts && <ArtifactsViewer artifacts={artifacts} />}

      {/* Previous spec shown dimmed below the new dashboard during follow-ups */}
      {previousSpec?.root && previousSpec?.elements && isStreaming && (
        <Card className="opacity-40">
          <CitationsContext.Provider value={specHasInvestigation(previousSpec)}>
            <StateProvider initialState={previousSpec.state ?? {}}>
              <ActionProvider handlers={registryActionHandlers}>
                <VisibilityProvider>
                  <RendererErrorBoundary>
                    <Renderer spec={previousSpec} registry={registry} />
                  </RendererErrorBoundary>
                </VisibilityProvider>
              </ActionProvider>
            </StateProvider>
          </CitationsContext.Provider>
        </Card>
      )}
    </div>
  );
}

const FILE_PIPELINE_STEPS = [
  { stage: "analyzing", label: "Analyzed your data", activeLabel: "Analyzing your data..." },
  { stage: "computing", label: "Ran computations", activeLabel: "Running computations..." },
  { stage: "composing", label: "Composed dashboard", activeLabel: "Composing dashboard..." },
] as const;

const WAREHOUSE_PIPELINE_STEPS = [
  { stage: "generating_sql", label: "Generated SQL query", activeLabel: "Generating SQL query..." },
  { stage: "querying_warehouse", label: "Queried warehouse", activeLabel: "Querying warehouse..." },
  { stage: "analyzing", label: "Analyzed results", activeLabel: "Analyzing results..." },
  { stage: "computing", label: "Ran computations", activeLabel: "Running computations..." },
  { stage: "composing", label: "Composed dashboard", activeLabel: "Composing dashboard..." },
] as const;

// Map stage names to step numbers per pipeline type
const FILE_STAGE_TO_STEP: Record<string, number> = {
  analyzing: 1,
  computing: 2,
  retrying: 2,
  composing: 3,
};

const WAREHOUSE_STAGE_TO_STEP: Record<string, number> = {
  generating_sql: 1,
  querying_warehouse: 2,
  analyzing: 3,
  computing: 4,
  retrying: 4,
  composing: 5,
};

const RETRYING_LABEL = "Fixing and retrying...";

function PipelineProgress({
  spec,
  drillStack,
  previousSpec,
}: {
  spec: Spec | null;
  drillStack: DrillLevel[];
  previousSpec: Spec | null;
}) {
  const progress = (spec?.state as Record<string, unknown> | undefined)?.__progress as
    | { stage: string; step: number; total: number }
    | undefined;

  // If dashboard content is already building, hide the stepper
  if (spec?.root) return null;

  // Fall back to generic messages when no progress data (drill-down, restored spec, etc.)
  if (!progress) {
    const message =
      drillStack.length > 0
        ? "Drilling down..."
        : previousSpec
          ? "Updating dashboard..."
          : "Building visualization...";
    return (
      <div
        className="flex flex-col items-center justify-center gap-3 py-20"
        role="status"
        aria-live="polite"
      >
        <div className="flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="inline-block h-2 w-2 rounded-full bg-accent"
              style={{
                animation: "pulse 1.2s ease-in-out infinite",
                animationDelay: `${i * 0.2}s`,
              }}
            />
          ))}
        </div>
        <span className="text-sm text-t-secondary">{message}</span>
      </div>
    );
  }

  const isWarehousePipeline = progress.total === 5;
  const pipelineSteps = isWarehousePipeline ? WAREHOUSE_PIPELINE_STEPS : FILE_PIPELINE_STEPS;
  const stageToStep = isWarehousePipeline ? WAREHOUSE_STAGE_TO_STEP : FILE_STAGE_TO_STEP;
  const currentStep = stageToStep[progress.stage] ?? progress.step;
  const isRetrying = progress.stage === "retrying";

  return (
    <div className="flex justify-center py-16" role="status" aria-live="polite">
      <div
        className="grid gap-x-8 gap-y-1.5 text-sm"
        style={{ gridTemplateColumns: "repeat(2, auto)" }}
      >
        {pipelineSteps.map((step, i) => {
          const stepNum = i + 1;
          const isCompleted = stepNum < currentStep;
          const isUpcoming = stepNum > currentStep;

          if (isUpcoming) {
            return (
              <div key={step.stage} className="flex items-center gap-2 text-t-tertiary">
                <span className="inline-block h-4 w-4" />
                {step.label}
              </div>
            );
          }

          if (isCompleted) {
            return (
              <div key={step.stage} className="flex items-center gap-2 text-t-secondary">
                <svg
                  className="h-4 w-4 text-success-text"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                {step.label}
              </div>
            );
          }

          // Active
          const retryStep = isWarehousePipeline ? 4 : 2;
          const label = isRetrying && stepNum === retryStep ? RETRYING_LABEL : step.activeLabel;
          return (
            <div key={step.stage} className="flex items-center gap-2 text-accent font-medium">
              <SpinnerIcon />
              {label}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface PlanStep {
  index: number;
  question: string;
  rationale: string;
  status: "pending" | "running" | "done" | "failed";
}

interface PlanState {
  approach?: string;
  steps?: PlanStep[];
}

interface ProgressMeta {
  stage?: string;
  step?: number;
  total?: number;
}

/**
 * Live progress UI for an Investigate stream. Reads two pieces of state
 * the server emits as patches:
 *
 *   /state/__plan       — { approach, steps[] } once planning is done
 *   /state/__progress   — { stage, step, total } each phase transition
 *
 * Status per step is updated in-place by /api/query/investigate as it
 * fires sub_started / sub_finished / sub_failed events.
 */
function InvestigateProgress({ spec }: { spec: Spec | null }) {
  const state = (spec?.state as Record<string, unknown> | undefined) ?? {};
  const plan = state.__plan as PlanState | undefined;
  const progress = state.__progress as ProgressMeta | undefined;
  const errorMsg = state.__error as string | undefined;

  // Once the dashboard root has started rendering, hide this UI — the
  // composed content takes over.
  if (spec?.root) return null;

  const stage = progress?.stage ?? "planning";
  const stageLabel =
    stage === "generating_sql"
      ? "Writing warehouse SQL..."
      : stage === "querying_warehouse"
        ? "Querying the warehouse..."
        : stage === "planning"
          ? "Planning the investigation..."
          : stage === "investigating"
            ? "Running sub-questions..."
            : stage === "composing"
              ? "Composing the unified dashboard..."
              : "Working...";

  return (
    <div className="flex flex-col gap-4 py-10" role="status" aria-live="polite">
      <div className="flex items-center justify-center gap-3">
        <SpinnerIcon />
        <span className="text-sm font-medium text-accent">{stageLabel}</span>
      </div>

      {plan?.approach && (
        <div className="mx-auto max-w-[700px] text-center text-sm text-t-secondary">
          {plan.approach}
        </div>
      )}

      {plan?.steps && plan.steps.length > 0 && (
        <ol className="mx-auto flex w-full max-w-[700px] flex-col gap-2 text-sm">
          {plan.steps.map((step) => (
            <li
              key={step.index}
              className="flex items-start gap-3 border border-border-default px-3 py-2"
              style={{
                borderRadius: "var(--radius-card)",
                background:
                  step.status === "running" ? "var(--color-accent-subtle)" : "transparent",
              }}
            >
              <span className="mt-0.5 shrink-0">
                <StepIcon status={step.status} />
              </span>
              <div className="flex-1">
                <div
                  className={
                    step.status === "failed"
                      ? "text-error-text"
                      : step.status === "done"
                        ? "text-t-secondary"
                        : "text-t-primary"
                  }
                >
                  <span className="font-medium">Step {step.index + 1}.</span> {step.question}
                </div>
                {step.rationale && (
                  <div className="mt-0.5 text-xs text-t-tertiary">{step.rationale}</div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {errorMsg && (
        <div
          className="mx-auto max-w-[700px] border border-error-border bg-error-bg p-3 text-sm text-error-text"
          style={{ borderRadius: "var(--radius-card)" }}
        >
          {errorMsg}
        </div>
      )}
    </div>
  );
}

interface DataQualityState {
  degraded?: { stepNo: number; question: string; reason?: string }[];
  failed?: { stepNo: number; question: string; error?: string }[];
  removed?: { stepNo: number; question: string }[];
}

interface GroundingState {
  ok?: boolean;
  checkedCount?: number;
  ungrounded?: string[];
  uncitedSuccessfulSteps?: number[];
}

/**
 * Surfaces the two Investigate trust signals the server emits as state:
 *   /state/__dataQuality — degraded / failed / dropped sub-questions
 *   /state/__grounding    — figures in the narrative that trace to no result
 *
 * Both render as compact banners above the composed dashboard. The full,
 * re-runnable detail lives in the artifacts panel's Trail tab.
 */
function InvestigationCaveats({ spec }: { spec: Spec | null }) {
  const state = (spec?.state as Record<string, unknown> | undefined) ?? {};
  const dq = state.__dataQuality as DataQualityState | undefined;
  const g = state.__grounding as GroundingState | undefined;

  const hasDq =
    !!dq && (dq.degraded?.length ?? 0) + (dq.failed?.length ?? 0) + (dq.removed?.length ?? 0) > 0;
  const hasUngrounded = !!g && g.ok === false && (g.ungrounded?.length ?? 0) > 0;
  if (!hasDq && !hasUngrounded) return null;

  return (
    <div className="mb-3 flex flex-col gap-2">
      {hasUngrounded && (
        <div
          className="border px-3 py-2 text-sm"
          style={{
            borderRadius: "var(--radius-card)",
            borderColor: "#d97706",
            background: "rgba(217, 119, 6, 0.08)",
            color: "#b45309",
          }}
        >
          <span className="font-medium">▲ Verify these figures.</span> {g!.ungrounded!.length}{" "}
          number{g!.ungrounded!.length === 1 ? "" : "s"} in the narrative could not be traced to a
          computed result: {g!.ungrounded!.join(", ")}. See the artifacts Trail for each step&apos;s
          code.
        </div>
      )}
      {hasDq && (
        <div
          className="border border-border-default px-3 py-2 text-sm"
          style={{ borderRadius: "var(--radius-card)" }}
        >
          <span className="font-medium text-t-primary">Data-quality notes:</span>
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-t-secondary">
            {dq!.failed?.map((s) => (
              <li key={`f${s.stepNo}`}>
                <span style={{ color: "#ef4444" }}>Step {s.stepNo} failed</span> — {s.question}
              </li>
            ))}
            {dq!.degraded?.map((s) => (
              <li key={`d${s.stepNo}`}>
                <span style={{ color: "#d97706" }}>Step {s.stepNo} degraded</span> — {s.question}
                {s.reason ? ` (${s.reason})` : ""}
              </li>
            ))}
            {dq!.removed?.map((s) => (
              <li key={`r${s.stepNo}`}>
                <span className="text-t-tertiary">Step {s.stepNo} dropped by re-planner</span> —{" "}
                {s.question}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function StepIcon({ status }: { status: PlanStep["status"] }) {
  if (status === "running") return <SpinnerIcon />;
  if (status === "done") {
    return (
      <svg
        className="h-4 w-4 text-success-text"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg
        className="h-4 w-4 text-error-text"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    );
  }
  // pending
  return (
    <span
      className="inline-block h-4 w-4 rounded-full border border-border-default"
      aria-hidden="true"
    />
  );
}

function SpinnerIcon() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}
