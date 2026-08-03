"use client";

import { useUIStream } from "@json-render/react";
import type { Spec } from "@json-render/react";
import { STORAGE_KEYS } from "@/lib/constants";
import { SpecView } from "@/components/spec-view";
import { CitationNavigateContext } from "@/components/registry-primitives";
import { logClient } from "@/lib/client-log";
import { resolveDrillValues, formatFilterValue, type ClickedRecord } from "@/lib/drill-resolve";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DrillDownParams } from "@/lib/contracts/spec-types";
import type { SchemaMode } from "@/lib/contracts/data-schema";
import type { ModelId, SandboxRuntimeId } from "@/lib/constants";
import type { CachedArtifacts } from "@/lib/contracts/investigation";
import type { TraceStep } from "@/lib/contracts/investigation";
import { useArtifacts } from "@/hooks/use-artifacts";
import { getArtifacts, recomposeInvestigation } from "@/lib/api";
import { ArtifactsViewer } from "@/components/app/artifacts-viewer";
import { NotebookView, type NotebookExportApi } from "@/components/app/notebook-view";
import { SelectionDrillBar } from "@/components/app/selection-drill-bar";
import { readStreamState, type CostInfo } from "@/lib/contracts/stream-state";
import type { AnalysisRequestContext } from "@/lib/contracts/analysis-request";
import { ActionButton } from "@/components/ui/action-button";
import { Card } from "@/components/ui/card";
import {
  specHasInvestigation,
  buildInvestigateScope,
  type DrillLevel,
} from "@/components/app/spec-insights";
import { ViewModeToggle } from "@/components/app/view-mode-toggle";
import {
  PipelineProgress,
  InvestigateProgress,
  InvestigationCaveats,
  SpinnerIcon,
  truncate,
} from "@/components/app/analysis-progress";

const VIEW_MODE_STORAGE_KEY = STORAGE_KEYS.investigateView;

/** Dashboard | Notebook segmented control for Investigate results. */
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
  warehouseId,
  question,
  questionSeq,
  mode = "ask",
  onStreamEnd,
  loadedSpec,
  loadedArtifacts,
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
  const currentSpecRef = useRef<Spec | null>(null);
  const currentQuestionRef = useRef<string | null>(question);
  // Conversation history is now managed server-side via the conversation cache.
  const [previousSpec, setPreviousSpec] = useState<Spec | null>(null);
  const lastSeqRef = useRef(0);
  // True while the in-flight stream is a REATTACH (replay of a run that survived
  // a client drop) rather than a fresh analysis. A reattach that ends without a
  // dashboard (run was stopped / channel raced closed / buffer incomplete) must
  // NOT leave a blank page — it re-runs fresh via onReattachFailed.
  const isReattachStreamRef = useRef(false);

  // Route the next stream to the right pipeline. The hook reads `api` per
  // call inside its useCallback, so toggling here before a new questionSeq
  // is enough — no remount required.
  // Reattaching to a live run streams from the attach endpoint (replay + live);
  // otherwise a fresh question hits the normal pipeline.
  const apiUrl = reattachRunId
    ? "/api/query/attach"
    : mode === "investigate"
      ? "/api/query/investigate"
      : "/api/query";

  // Diagnostics for the mid-stream abort: useUIStream aborts its fetch when this
  // panel unmounts, so a long query dies if anything tears the panel down. Track
  // when a stream is live so onError + the unmount cleanup can report it.
  const streamStartedAtRef = useRef<number | null>(null);
  const streamingRef = useRef(false);

  const { spec, isStreaming, error, send, clear } = useUIStream({
    api: apiUrl,
    onComplete: (completedSpec) => {
      // A reattach that replayed to the end but produced no dashboard means the
      // run was stopped / its channel raced closed / its buffer was incomplete.
      // Replaying it would blank the page (no root → no dashboard; stream ended
      // → no progress), so re-run the question fresh instead.
      if (isReattachStreamRef.current) {
        isReattachStreamRef.current = false;
        if (!completedSpec?.root) {
          onStreamEnd?.(); // let the parent clear reattachRunId
          onReattachFailed?.();
          return;
        }
      }
      currentSpecRef.current = completedSpec;
      setPreviousSpec(null);
      onStreamEnd?.();
      const cost = readStreamState(completedSpec).__cost;
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
      // A reattach that errored (e.g. the attach endpoint 404'd because the run
      // ended) — recover by re-running fresh rather than stranding a blank page.
      // But an AbortError is this panel unmounting (user navigated away), NOT a
      // failed reattach — don't kick off a spurious background run in that case.
      if (isReattachStreamRef.current) {
        isReattachStreamRef.current = false;
        const aborted = (err as { name?: string })?.name === "AbortError";
        if (!aborted) onReattachFailed?.();
      }
    },
  });

  // For warehouse queries, the csvId is generated server-side and emitted in the stream
  const warehouseCsvId = readStreamState(spec).__warehouse_csv_id;
  const effectiveCsvId = csvId ?? warehouseCsvId ?? null;

  // Save/Export moved to the top bar — page.tsx owns the live useSaveExport
  // instance. A second instance here was fully dead (none of its 7 values
  // were consumed) yet kept its own state/effects per render and, worse,
  // diverged from the page's on csvId (page uses csvId, this used
  // effectiveCsvId) — a drift trap for whichever instance was "authoritative".
  // Only the artifacts-panel state survives here.
  const { showArtifacts, setShowArtifacts, artifacts, setArtifacts } = useArtifacts({
    csvId: effectiveCsvId,
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

    // Reattach is handled by its own effect (keyed on reattachRunId), NOT here.
    // On resume the panel mounts with questionSeq already advanced, so a send in
    // this effect would fire during the initial mount — where React StrictMode's
    // dev mount→unmount→remount aborts the fetch (useUIStream aborts on unmount)
    // and this effect's lastSeqRef guard then blocks the re-send on remount,
    // stranding the attach stream (blank progress). See the reattach effect below.
    if (reattachRunId) return;

    // Conversation history is managed server-side (keyed by csvId)
    isReattachStreamRef.current = false;
    send("", {
      csv_id: csvId ?? undefined,
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
    } satisfies AnalysisRequestContext);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionSeq]);

  // Reattach to a run still executing server-side (replay so far, then live to
  // completion). Kept in its OWN effect keyed on reattachRunId — deliberately
  // NOT the questionSeq effect above — so it survives a remount. On resume the
  // panel mounts with reattachRunId already set, so the attach send fires during
  // the initial mount; React StrictMode (dev) then aborts that fetch on its
  // simulated unmount. Because this effect re-runs on the remount (no lastSeqRef
  // latch), useUIStream aborts the first fetch and the second one streams — the
  // questionSeq effect's guard used to swallow that retry, leaving the panel
  // stuck on the progressless seed ("Building visualization…"). Also correct in
  // production, where the effect simply runs once.
  useEffect(() => {
    if (!reattachRunId) return;
    isReattachStreamRef.current = true;
    send("", { runId: reattachRunId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reattachRunId]);

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
      } satisfies AnalysisRequestContext);
    },
    // Full dep list: the callback SENDS schemaMode / models / runtime /
    // purpose / viewMode — the old ref-assignment effect once listed only
    // three deps behind a disable, so changed settings drilled stale.
    [
      effectiveCsvId,
      warehouseId,
      send,
      schemaMode,
      codeGenModel,
      uiComposeModel,
      sandboxRuntime,
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
              sandboxRuntime={sandboxRuntime}
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
      {showArtifacts && artifacts && <ArtifactsViewer artifacts={artifacts} />}

      {/* Previous spec shown dimmed below the new dashboard during follow-ups */}
      {previousSpec?.root && previousSpec?.elements && isStreaming && (
        <Card className="opacity-40">
          <SpecView spec={previousSpec} citations={specHasInvestigation(previousSpec)} />
        </Card>
      )}
    </div>
  );
}
