"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import dynamic from "next/dynamic";
import type { Spec } from "@json-render/react";
import { SheetPicker } from "@/components/app/sheet-picker";
import { QueryInput, type QueryMode } from "@/components/app/query-input";
import { SavedVizsPanel } from "@/components/app/saved-vizs-panel";

// New redesign components
import { TopBar } from "@/components/app/top-bar";
import { SourcePill } from "@/components/app/source-pill";
import { MainContent } from "@/components/app/main-content";
import { SettingsDrawer } from "@/components/app/settings-drawer";
import { DataRail } from "@/components/app/data-rail";
import { DataRailContent } from "@/components/app/data-rail-content";
import type { RecentItem } from "@/components/app/recent-sources";
import { AskComposer } from "@/components/app/home/ask-composer";
import { AddDataMenu, type SavedConnectionItem } from "@/components/app/home/add-data-menu";
import { ExampleCards, type ExampleRun } from "@/components/app/home/example-cards";
import { usePendingAsk } from "@/hooks/use-pending-ask";
import { RECENTS_CHANGED_EVENT, STORAGE_KEYS } from "@/lib/constants";
import { relTimeAgo } from "@/lib/rel-time";
import { ENGINES } from "@/lib/warehouse/engine-descriptor";
import { LocalFileBrowser } from "@/components/app/local-file-browser";

import { InlineConnectionForm } from "@/components/app/inline-connection-form";

import { StyleSelector } from "@/components/app/style-selector";
import { StyleDropdown } from "@/components/app/style-dropdown";
import { useSaveExport } from "@/hooks/use-save-export";
import { useVizActions } from "@/hooks/use-viz-actions";
import { useSourceSelect } from "@/hooks/use-source-select";
import { useHistoryRestore } from "@/hooks/use-history-restore";
import { RefreshProgress } from "@/components/app/refresh-progress";
import { ArtifactsPanel } from "@/components/app/artifacts-panel";
import { CostFooter, type CostInfo } from "@/components/app/cost-footer";
import { useArtifacts } from "@/hooks/use-artifacts";
import { useSuggestions } from "@/hooks/use-suggestions";
import { AnalysisHistory, type HistoryEntry } from "@/components/app/analysis-history";
import { SuggestionPills } from "@/components/app/suggestion-pills";
import { SchedulePopover } from "@/components/app/schedule-popover";

import type { NotebookExportApi } from "@/components/app/notebook-view";

// Lazy-load ResponsePanel — it pulls in plotly.js, globe.gl, maplibre-gl, three.js etc.
const ResponsePanel = dynamic(
  () => import("@/components/app/response-panel").then((m) => m.ResponsePanel),
  { ssr: false }
);
import { useCSVUpload } from "@/hooks/use-csv-upload";
import { useWarehouse } from "@/hooks/use-warehouse";
import { usePageState } from "@/hooks/use-page-state";
import type { SchemaMode } from "@/lib/contracts/data-schema";
import { DEFAULT_PURPOSE } from "@/lib/purpose-prompts";
import {
  checkLlmReady,
  getLocalBackendConfig,
  saveHistoryEntry,
  getRecentSources,
  getSchemaByCsvId,
  type RecentSourceInfo,
  type ActiveRun,
} from "@/lib/api";
import { useActiveRuns } from "@/hooks/use-active-runs";
import { ActiveRunsBanner } from "@/components/app/active-runs-banner";
import {
  CODE_GEN_MODEL,
  UI_COMPOSE_MODEL,
  DEFAULT_SANDBOX_RUNTIME,
  isValidRuntimeId,
  isValidModelId,
} from "@/lib/constants";
import type { ModelId, SandboxRuntimeId } from "@/lib/constants";
import { setActiveSandboxRuntime } from "@/lib/api";
import { useCurrentAnalysis } from "@/hooks/use-current-analysis";

/** Compact row count for a recent-source subtitle: 2547927232 → "2.5B". */
function fmtRowCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

export default function Home() {
  // ── Existing hooks & state (unchanged) ──────────────────────
  const {
    csvId,
    schema,
    isUploaded,
    excelMeta,
    showSheetPicker,
    isWorkbookMode,
    handleUpload,
    handleWorkbookUpload,
    loadWorkbookUpload,
    handleExcelSheets,
    cancelSheetPicker,
    reset,
  } = useCSVUpload();
  const warehouse = useWarehouse();
  const {
    state: pageState,
    dispatch,
    query: handleQuery,
    streamEnd: handleStreamEnd,
    resetPage,
    toggleSaved,
    vizSaved: handleSaved,
  } = usePageState();
  const {
    currentQuestion,
    questionSeq,
    isAnalyzing,
    currentMode,
    loadedSpec,
    loadedArtifacts,
    showSaved,
    savedRefreshKey,
    loadingViz,
    rerunningViz,
    pendingRerunVizId,
    rerunCode,
    rerunSql,
    loadedVizId,
    refreshStage,
  } = pageState;
  const [schemaMode, setSchemaMode] = useState<SchemaMode>("metadata");
  const [purpose, setPurpose] = useState(DEFAULT_PURPOSE);
  const [codeGenModel, setCodeGenModel] = useState<ModelId>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(STORAGE_KEYS.codeGenModel);
      if (stored && isValidModelId(stored)) return stored;
    }
    return CODE_GEN_MODEL;
  });
  const [uiComposeModel, setUiComposeModel] = useState<ModelId>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(STORAGE_KEYS.uiComposeModel);
      if (stored && isValidModelId(stored)) return stored;
    }
    return UI_COMPOSE_MODEL;
  });
  const [sandboxRuntime, setSandboxRuntime] = useState<SandboxRuntimeId>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem(STORAGE_KEYS.sandboxRuntime);
      if (stored && isValidRuntimeId(stored)) return stored;
    }
    return DEFAULT_SANDBOX_RUNTIME;
  });
  const [ollamaModel, setOllamaModel] = useState<string | null>(null);
  const [llmWarning, setLlmWarning] = useState<string | null>(null);
  // Lifted here from QueryInput so suggestion pills and history replays
  // inherit whichever mode the user toggled the input to.
  const [queryMode, setQueryMode] = useState<QueryMode>("ask");
  const uploadInputRef = useRef<HTMLInputElement>(null);

  const dashboardRef = useRef<HTMLDivElement>(null);
  // ONE holder for the analysis on screen (M5-5e) — replaces currentSpecRef,
  // currentQuestionRef, and lastCompleteSpec plus their hand-rolled syncs.
  const analysis = useCurrentAnalysis({ loadedSpec, currentQuestion, isAnalyzing });
  const currentSpecRef = analysis.specRef;
  const currentQuestionRef = analysis.questionRef;

  // ── New redesign state ──────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [railExpanded, setRailExpanded] = useState(false);
  // Cost footer: last analysis cost + running session total.
  const [lastCost, setLastCost] = useState<CostInfo | null>(null);
  const [sessionCost, setSessionCost] = useState(0);
  const [railFullscreen, setRailFullscreen] = useState(false);
  const [showWarehouseForm, setShowWarehouseForm] = useState(false);
  const [showExportDropdown, setShowExportDropdown] = useState(false);
  // Notebook export handlers registered by the active NotebookView. When set,
  // the Export menu shows notebook formats (Markdown/HTML/PDF) instead of the
  // dashboard formats. `menuExporting` tracks the in-flight notebook format.
  const [notebookExportApi, setNotebookExportApi] = useState<NotebookExportApi | null>(null);
  const [menuExporting, setMenuExporting] = useState<string | null>(null);
  const [showArtifactsPanel, setShowArtifactsPanel] = useState(false);
  const [artifactsFullscreen, setArtifactsFullscreen] = useState(false);
  // Schedule popover anchored to the toolbar Schedule button. Holds the
  // anchorRect (for positioning) and the vizId being scheduled.
  const [scheduleState, setScheduleState] = useState<
    | { kind: "closed" }
    | { kind: "auto-saving" }
    | { kind: "open"; vizId: string; anchorRect: DOMRect }
  >({ kind: "closed" });
  const [effectiveCsvId, setEffectiveCsvId] = useState<string | null>(null);
  const [analysisHistory, setAnalysisHistory] = useState<HistoryEntry[]>([]);
  /**
   * The spec from the most recently completed analysis. Captured via
   * ResponsePanel's `onAnalysisComplete` callback because the streamed
   * spec lives inside ResponsePanel's `useUIStream` hook — it's not in
   * page-level state. Cleared when a new analysis starts or the data
   * source changes.
   */

  // Mutual exclusion: only one panel open at a time
  const openSettings = useCallback(() => {
    setRailExpanded(false);
    setRailFullscreen(false);
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const expandRail = useCallback(() => {
    setSettingsOpen(false);
    setRailExpanded(true);
  }, []);
  const collapseRail = useCallback(() => {
    setRailExpanded(false);
    setRailFullscreen(false);
  }, []);
  const toggleRailFullscreen = useCallback(() => {
    setRailFullscreen((f) => !f);
  }, []);

  const anyPanelOpen = settingsOpen || railExpanded;

  const {
    saving,
    saveMessage,
    exporting,
    handleSave: doSave,
    handleExportPdf,
    handleExportDocx,
    handleExportPptx,
    lastSavedVizId,
  } = useSaveExport({
    // effectiveCsvId first (M5-5e): a warehouse analysis materializes its
    // data under a NEW csvId reported mid-stream — saving under the raw
    // upload id (null for warehouse runs) was the audit's save-vs-artifacts
    // id divergence.
    csvId: effectiveCsvId ?? csvId,
    currentSpecRef,
    currentQuestionRef,
    dashboardRef,
    onSaved: handleSaved,
  });

  // Page-level artifacts — uses effectiveCsvId reported by ResponsePanel
  const pageArtifacts = useArtifacts({ csvId: effectiveCsvId });

  /**
   * Open the schedule popover. If the current viz hasn't been saved yet
   * (no vizId), auto-save first to obtain one. The popover anchors to the
   * Schedule button via its DOMRect.
   */
  const handleScheduleClick = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      const anchorRect = e.currentTarget.getBoundingClientRect();
      if (loadedVizId) {
        setScheduleState({ kind: "open", vizId: loadedVizId, anchorRect });
        return;
      }
      if (lastSavedVizId) {
        setScheduleState({ kind: "open", vizId: lastSavedVizId, anchorRect });
        return;
      }
      setScheduleState({ kind: "auto-saving" });
      const newVizId = await doSave();
      if (!newVizId) {
        setScheduleState({ kind: "closed" });
        return;
      }
      setScheduleState({ kind: "open", vizId: newVizId, anchorRect });
    },
    [loadedVizId, lastSavedVizId, doSave]
  );

  // URL-driven history restore / re-run (?restore= / ?rerun_history=) —
  // see use-history-restore.ts.
  useHistoryRestore({
    dispatch,
    handleUpload,
    warehouseId: warehouse.warehouseId,
    sandboxRuntime,
  });

  // Close export dropdown on outside click
  useEffect(() => {
    if (!showExportDropdown) return;
    const handler = () => setTimeout(() => setShowExportDropdown(false), 0);
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [showExportDropdown]);

  // ── Existing effects & callbacks (unchanged) ────────────────
  useEffect(() => {
    const controller = new AbortController();
    getLocalBackendConfig(controller.signal)
      .then((data) => {
        const active =
          data.mlx?.enabled && data.mlx?.activeModel
            ? data.mlx.activeModel
            : data.llamaCpp?.enabled && data.llamaCpp?.activeModel
              ? data.llamaCpp.activeModel
              : data.ollama?.enabled && data.ollama?.activeModel
                ? data.ollama.activeModel
                : null;
        if (active) setOllamaModel(active);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const handleGuardedQuery = useCallback(
    async (question: string, mode?: QueryMode) => {
      setLlmWarning(null);
      const readiness = await checkLlmReady();
      if (!readiness.ready) {
        setLlmWarning(readiness.message ?? "LLM is not available.");
        openSettings();
        return;
      }
      // Callers without an explicit mode (suggestion pills, history replay)
      // inherit the currently-selected mode from the QueryInput.
      handleQuery(question, mode ?? queryMode);
    },
    [handleQuery, openSettings, queryMode]
  );

  // Changing the output style re-asks the current question with the new
  // style so the form actually changes (and the transition is visible).
  // The settings "default style" picker uses plain setPurpose (no re-run) —
  // it only affects the NEXT question.
  const handleStyleChange = useCallback(
    (id: string) => {
      setPurpose(id);
      // Re-ask only when a result already exists for the current question.
      if (currentQuestion && !isAnalyzing) {
        handleGuardedQuery(currentQuestion, currentMode);
      }
    },
    [currentQuestion, isAnalyzing, currentMode, handleGuardedQuery]
  );

  // Dashboard "Slides" export — segment the rendered dashboard into a Reveal
  // deck. (Notebook view registers its own slides handler via the export API.)
  const handleExportSlides = useCallback(async () => {
    const root = dashboardRef.current;
    if (!root) return;
    const { downloadAsSlides } = await import("@/lib/slides-export");
    await downloadAsSlides(root, currentQuestionRef.current ?? "dashboard");
  }, []);

  const handleRuntimeChange = useCallback((r: SandboxRuntimeId) => {
    setSandboxRuntime(r);
    localStorage.setItem(STORAGE_KEYS.sandboxRuntime, r);
    setActiveSandboxRuntime(r).catch(() => {});
  }, []);

  // Persist the model choices to localStorage so they survive a restart (the
  // value is sent with every query, so client-side is enough). Previously these
  // only called setState → reverted to the default constant on reload.
  const handleCodeGenModelChange = useCallback((m: ModelId) => {
    setCodeGenModel(m);
    localStorage.setItem(STORAGE_KEYS.codeGenModel, m);
  }, []);
  const handleUiComposeModelChange = useCallback((m: ModelId) => {
    setUiComposeModel(m);
    localStorage.setItem(STORAGE_KEYS.uiComposeModel, m);
  }, []);

  // Local/remote/upload/sample source selection — see use-source-select.ts.
  const {
    showLocalBrowser,
    setShowLocalBrowser,
    isExtractingLocalSchema,
    handleLocalFileSelect,
    handleRemoteFileSelect,
    refreshRemote,
    hasRemoteSource,
    processUploadFile,
    handleSampleData,
    resetSourceSelect,
    sourceError,
    clearSourceError,
  } = useSourceSelect({ handleUpload, handleExcelSheets });

  // ── Recent sources (uploads / local / cloud) — the file/cloud analogue of
  // saved warehouse connections. Loaded on mount; recorded server-side on every
  // connect, so we just refetch after each open/remove. Warehouses are merged in
  // from the warehouse hook for one unified "Recent" list.
  const [recents, setRecents] = useState<RecentSourceInfo[]>([]);
  const refetchRecents = useCallback(() => {
    void getRecentSources().then(setRecents);
  }, []);
  useEffect(() => refetchRecents(), [refetchRecents]);
  // Stay in sync with renames/removals made in Settings → Recent sources.
  useEffect(() => {
    window.addEventListener(RECENTS_CHANGED_EVENT, refetchRecents);
    return () => window.removeEventListener(RECENTS_CHANGED_EVENT, refetchRecents);
  }, [refetchRecents]);

  const recentItems = useMemo<RecentItem[]>(() => {
    const files = recents.map((r) => ({
      ts: r.lastUsedAt,
      item: {
        id: r.id,
        kind: r.kind,
        name: r.name,
        subtitle: r.subtitle,
        meta: [r.rows != null ? `${fmtRowCount(r.rows)} rows` : null, relTimeAgo(r.lastUsedAt)]
          .filter(Boolean)
          .join(" · "),
      } as RecentItem,
    }));
    const whs = warehouse.savedConnections.map((c) => ({
      ts: c.createdAt,
      item: {
        id: c.id,
        kind: "warehouse" as const,
        name: c.name ?? c.label,
        subtitle: "host" in c.config ? c.config.host : c.config.type,
        meta: relTimeAgo(c.createdAt),
        brandColor: ENGINES[c.config.type]?.brandColor,
      } as RecentItem,
    }));
    return [...files, ...whs].sort((a, b) => b.ts.localeCompare(a.ts)).map((x) => x.item);
  }, [recents, warehouse.savedConnections]);

  // Re-open (or refresh) a remembered source. Uploads re-open from their managed
  // byte copy (a file under ~/.hermetic), so they route through the same local-
  // file path as an on-disk file.
  const reopenRecent = useCallback(
    async (item: RecentItem, force = false) => {
      try {
        if (item.kind === "warehouse") {
          const saved = warehouse.savedConnections.find((c) => c.id === item.id);
          if (saved) await warehouse.connect(saved.config, force);
          return;
        }
        const src = recents.find((r) => r.id === item.id);
        if (!src) return;
        if (src.kind === "remote-parquet" && src.url) {
          await handleRemoteFileSelect(src.url, src.creds, force);
        } else if (src.kind === "local-folder" && src.path) {
          await handleLocalFileSelect(src.path, "folder");
        } else if (src.path) {
          await handleLocalFileSelect(src.path, "file");
        }
      } finally {
        refetchRecents();
      }
    },
    [recents, warehouse, handleRemoteFileSelect, handleLocalFileSelect, refetchRecents]
  );

  // Schema-sidebar "refresh" — re-read the current source's schema, ignoring the
  // cache. Only cache-backed sources (warehouse / remote Parquet) offer it; an
  // uploaded CSV has no source to re-read. A remote-Parquet source shows as a
  // CSV sourceType but has a retained remote ref (refreshRemote no-ops otherwise).
  const onRefreshSchema = warehouse.isConnected
    ? warehouse.refresh
    : hasRemoteSource
      ? refreshRemote
      : undefined;

  const handleReset = useCallback(() => {
    reset();
    warehouse.reset();
    resetPage(); // RESET returns to initialState → loadedVizId/refreshStage null
    setShowWarehouseForm(false);
    resetSourceSelect();
  }, [reset, warehouse, resetPage, resetSourceSelect]);

  // Saved-viz load / re-run / refresh + auto-save-after-rerun — see
  // use-viz-actions.ts. Owns the hidden rerun file input's ref.
  const {
    fileInputRef,
    handleLoadViz,
    handleRerunViz,
    handleRerunFileSelected,
    handleRerunFromToolbar,
    handleRefreshViz,
    handleRefreshFromToolbar,
  } = useVizActions({
    dispatch,
    handleUpload,
    loadWorkbookUpload,
    warehouseId: warehouse.warehouseId,
    sandboxRuntime,
    loadedVizId,
    isAnalyzing,
    pendingRerunVizId,
    csvId,
    loadedSpec,
    currentQuestion,
  });

  // ── Question suggestions (initial + follow-up) — see use-suggestions.ts ──
  // Drives off analysis.freshSpec (the last COMPLETED stream) — not
  // pageState.loadedSpec, which is only set when LOADING a saved viz.
  const { suggestions, followUpSuggestions } = useSuggestions({
    schema,
    warehouse,
    isAnalyzing,
    currentQuestion,
    lastCompleteSpec: analysis.freshSpec,
    effectiveCsvId,
    csvId,
    // Switching sources resets source-scoped page state.
    onSourceChange: () => setAnalysisHistory([]),
  });

  // Status now driven by ResponsePanel's PipelineProgress (real pipeline stages)

  // ── Derived state ───────────────────────────────────────────
  const hasData = isUploaded || warehouse.isConnected;
  const isState1 = !hasData && !showSheetPicker && !showSaved && !loadingViz && !rerunningViz;
  // hasResults: true when there are results to display (queried or loaded a viz)
  const hasResults = questionSeq > 0 || !!loadedSpec;
  const isState2 = hasData && !isAnalyzing && !hasResults;
  const isState3 = isAnalyzing;
  const isState4 = hasData && !isAnalyzing && hasResults;

  // ── Reconnect to a run that survived a client drop (reload / HMR) ──
  // When the page had no source loaded (fresh tab), offer to resume an analysis
  // still executing server-side; resuming restores the source and reattaches
  // ResponsePanel to the live stream (see run-stream-hub / useActiveRuns).
  const [reattachRunId, setReattachRunId] = useState<string | null>(null);
  const activeRuns = useActiveRuns({ enabled: isState1 });
  const resumeActiveRun = useCallback(
    async (run: ActiveRun) => {
      if (!run.csvId) return;
      const restored = await getSchemaByCsvId(run.csvId);
      if (!restored) {
        activeRuns.dismiss(run.runId); // source expired — nothing to reattach to
        return;
      }
      handleUpload(restored.csv_id, restored.schema); // hasData → true, mounts ResponsePanel
      setReattachRunId(run.runId);
      handleQuery(
        run.question || "Analysis",
        run.route.includes("investigate") ? "investigate" : "ask"
      );
    },
    [handleUpload, handleQuery, activeRuns]
  );
  // Clear the reattach marker whenever a stream ends, so the next follow-up runs
  // through the normal pipeline rather than the attach endpoint.
  const handleStreamEndReattachAware = useCallback(() => {
    handleStreamEnd();
    setReattachRunId(null);
  }, [handleStreamEnd]);

  // A resume that reattached to a run which was already stopped/finished (no live
  // stream, incomplete buffer) would render a blank page. Recover by clearing the
  // reattach marker and re-running the question fresh, so progress + a result show.
  const handleReattachFailed = useCallback(() => {
    setReattachRunId(null);
    if (currentQuestion) handleQuery(currentQuestion, currentMode);
  }, [handleQuery, currentQuestion, currentMode]);

  // ── Ask-first composer (home) ───────────────────────────────
  // The question is typed BEFORE data exists; attaching a source is async, so
  // the question is armed and fires once the source is ready (isState2).
  const [homeQuestion, setHomeQuestion] = useState("");
  const runPendingAsk = useCallback(
    (question: string, mode: QueryMode) => {
      setQueryMode(mode);
      void handleGuardedQuery(question, mode);
    },
    [handleGuardedQuery]
  );
  const { arm: armPendingAsk } = usePendingAsk(isState2, runPendingAsk);

  // Every attach action arms the currently-typed question (if any) so picking
  // a source with a question already written runs it with zero extra clicks.
  const armFromComposer = useCallback(() => {
    const q = homeQuestion.trim();
    if (q) armPendingAsk({ question: q, mode: queryMode });
  }, [homeQuestion, queryMode, armPendingAsk]);

  const composerUpload = useCallback(() => {
    armFromComposer();
    if (uploadInputRef.current) uploadInputRef.current.value = "";
    uploadInputRef.current?.click();
  }, [armFromComposer]);

  const composerLocalBrowse = useCallback(() => {
    if (sandboxRuntime !== "docker") {
      const label =
        sandboxRuntime === "e2b"
          ? "E2B (Cloud)"
          : sandboxRuntime === "microsandbox"
            ? "Microsandbox"
            : sandboxRuntime;
      alert(
        `Local file browsing requires the Docker runtime.\n\nCurrent runtime: ${label}.\nSwitch to Docker in Settings or re-run ./start.sh.`
      );
      return;
    }
    armFromComposer();
    setShowLocalBrowser(true);
  }, [armFromComposer, sandboxRuntime, setShowLocalBrowser]);

  const composerNewWarehouse = useCallback(() => {
    armFromComposer();
    setShowWarehouseForm(true);
  }, [armFromComposer]);

  const composerSavedConnect = useCallback(
    (id: string) => {
      const saved = warehouse.savedConnections.find((c) => c.id === id);
      if (!saved) return;
      armFromComposer();
      void warehouse.connect(saved.config);
    },
    [armFromComposer, warehouse]
  );

  const composerSample = useCallback(() => {
    armFromComposer();
    void handleSampleData();
  }, [armFromComposer, handleSampleData]);

  const composerOpenRecent = useCallback(
    (item: RecentItem) => {
      armFromComposer();
      void reopenRecent(item);
    },
    [armFromComposer, reopenRecent]
  );

  // Example cards: question + sample dataset + mode in one click.
  const runExample = useCallback(
    (run: ExampleRun) => {
      setQueryMode(run.mode);
      setHomeQuestion(run.question);
      armPendingAsk({ question: run.question, mode: run.mode });
      void handleSampleData();
    },
    [armPendingAsk, handleSampleData]
  );

  const savedConnectionItems = useMemo<SavedConnectionItem[]>(
    () =>
      warehouse.savedConnections.map((c) => ({
        id: c.id,
        name: c.name ?? c.label,
        brandColor: ENGINES[c.config.type]?.brandColor,
      })),
    [warehouse.savedConnections]
  );

  const renderAddDataMenu = useCallback(
    (close: () => void) => (
      <AddDataMenu
        recents={recentItems}
        savedConnections={savedConnectionItems}
        onOpenRecent={composerOpenRecent}
        onUpload={composerUpload}
        onLocalBrowse={composerLocalBrowse}
        onNewWarehouse={composerNewWarehouse}
        onSavedConnect={composerSavedConnect}
        onSample={composerSample}
        onPicked={close}
      />
    ),
    [
      recentItems,
      savedConnectionItems,
      composerOpenRecent,
      composerUpload,
      composerLocalBrowse,
      composerNewWarehouse,
      composerSavedConnect,
      composerSample,
    ]
  );

  // Build profile strip items from schema or warehouse
  const profileItems: string[] = [];
  if (schema) {
    profileItems.push(`${schema.row_count.toLocaleString()} rows`);
    profileItems.push(`${schema.columns.length} columns`);
    if (schema.columns.length > 0) {
      const colNames = schema.columns.slice(0, 4).map((c) => c.name);
      if (schema.columns.length > 4) colNames.push(`+${schema.columns.length - 4} more`);
      profileItems.push(colNames.join(" · "));
    }
  } else if (warehouse.isConnected) {
    profileItems.push(`${warehouse.tableCount} tables`);
    profileItems.push(`${warehouse.totalColumns} columns`);
  }

  // Composer data-chip label — the attached dataset/connection, State 2+.
  const datasetLabel = schema
    ? (schema.filename ?? "Uploaded data")
    : warehouse.isConnected
      ? `${warehouse.warehouseType ?? "Warehouse"} · ${warehouse.tableCount} tables`
      : null;

  // Source label for top bar pill
  const sourceLabel = schema
    ? `✓ ${schema.filename ?? "data"} · ${schema.row_count.toLocaleString()} rows · ${schema.columns.length} columns`
    : warehouse.isConnected
      ? `✓ ${warehouse.warehouseType ?? "Warehouse"} · ${warehouse.tableCount} tables · ${warehouse.totalColumns} columns`
      : "";

  // Build data rail schema from CSV schema or warehouse
  const mapSchemaCol = (c: { name: string; dtype: string; sample_values?: string[] }) => ({
    name: c.name,
    type: c.dtype === "number" ? "number" : c.dtype === "date" ? "date" : "text",
    sample: c.sample_values?.[0] ?? "",
  });
  const railSchema = schema?.columns.slice(0, 8).map(mapSchemaCol);
  const railAllSchema = schema?.columns.map(mapSchemaCol);
  const railMoreColumns = schema ? Math.max(0, schema.columns.length - 8) : 0;

  // ── Render ──────────────────────────────────────────────────
  return (
    <>
      {/* Hidden file input for rerun */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.xlsx,.geojson,.json"
        className="hidden"
        onChange={handleRerunFileSelected}
      />
      {/* Hidden file input for initial upload (triggered by SourceCard click) */}
      <input
        ref={uploadInputRef}
        type="file"
        accept=".csv,.xlsx,.geojson,.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) processUploadFile(file);
        }}
      />

      {/* Top Bar */}
      <TopBar
        onLogoClick={handleReset}
        center={
          hasData && !isState1 ? (
            isState4 ? (
              <span
                className="text-sm text-t-secondary"
                style={{
                  maxWidth: 400,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  display: "block",
                }}
              >
                {currentQuestion}
              </span>
            ) : (
              <SourcePill label={sourceLabel} />
            )
          ) : undefined
        }
        right={
          <div className="flex items-center gap-3">
            <a
              href="/history"
              className="p-1 transition-colors text-t-secondary hover:text-t-primary"
              title="Analysis history"
              aria-label="Analysis history"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                viewBox="0 0 24 24"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </a>
            <button
              onClick={toggleSaved}
              className={`p-1 transition-colors ${showSaved ? "text-accent" : "text-t-secondary hover:text-t-primary"}`}
              title="Saved visualizations"
              aria-label="Saved visualizations"
            >
              <svg
                className="h-5 w-5"
                fill={showSaved ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="1.8"
                viewBox="0 0 24 24"
              >
                <path
                  d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            {/* State 4 actions: style switch, Re-run, Save, Export, Artifacts */}
            {isState4 && (
              <>
                {/* Switch the output style on an existing result — re-composes
                    with the new form (and animates the transition). Compact
                    dropdown so it doesn't crowd the toolbar. */}
                <div className="hidden sm:block">
                  <StyleDropdown selected={purpose} onSelect={handleStyleChange} />
                </div>
                {loadedVizId && (
                  <button
                    onClick={handleRefreshFromToolbar}
                    disabled={rerunningViz}
                    className="text-sm font-medium text-t-secondary hover:text-accent transition-colors disabled:opacity-50"
                  >
                    {rerunningViz ? "Re-running..." : "Re-run"}
                  </button>
                )}
                <button
                  onClick={doSave}
                  disabled={saving || !!exporting}
                  className="text-sm font-medium text-t-secondary hover:text-accent transition-colors disabled:opacity-50"
                >
                  {saving ? "✓" : "Save"}
                </button>
                {/* Save/export status — failures were previously silent from
                    the toolbar (the only consumer of saveMessage was a dead
                    hook instance in ResponsePanel). */}
                {saveMessage && (
                  <span
                    role="status"
                    className={`text-xs ${saveMessage.includes("fail") ? "text-error-text" : "text-t-tertiary"}`}
                  >
                    {saveMessage}
                  </span>
                )}
                <button
                  onClick={handleScheduleClick}
                  disabled={scheduleState.kind === "auto-saving" || saving || !!exporting}
                  className="text-sm font-medium text-t-secondary hover:text-accent transition-colors disabled:opacity-50"
                  title="Schedule re-runs of this analysis"
                >
                  {scheduleState.kind === "auto-saving" ? "Saving…" : "Schedule"}
                </button>
                <div className="relative">
                  <button
                    onClick={() => setShowExportDropdown((v) => !v)}
                    className="text-sm font-medium text-t-secondary hover:text-accent transition-colors"
                  >
                    Export ▾
                  </button>
                  {showExportDropdown && (
                    <div
                      className="absolute right-0 top-full mt-1 border border-border-default bg-surface-1 py-1"
                      style={{
                        borderRadius: "var(--radius-button)",
                        boxShadow: "var(--shadow-elevated)",
                        zIndex: "var(--z-export-dropdown)",
                        minWidth: 160,
                      }}
                    >
                      {/* Options adapt to the active view: notebook formats in
                          Notebook view, dashboard formats otherwise. */}
                      {(notebookExportApi
                        ? [
                            { label: "Markdown", fn: notebookExportApi.markdown },
                            { label: "HTML", fn: notebookExportApi.html },
                            { label: "PDF", fn: notebookExportApi.pdf },
                            { label: "Slides", fn: notebookExportApi.slides },
                          ]
                        : [
                            { label: "PDF", fn: handleExportPdf },
                            { label: "DOCX", fn: handleExportDocx },
                            { label: "PPTX", fn: handleExportPptx },
                            { label: "Slides", fn: handleExportSlides },
                          ]
                      ).map((item) => (
                        <button
                          key={item.label}
                          onClick={async () => {
                            setShowExportDropdown(false);
                            try {
                              setMenuExporting(item.label);
                              await item.fn();
                            } finally {
                              setMenuExporting(null);
                            }
                          }}
                          disabled={!!exporting || !!menuExporting}
                          className="block w-full px-4 py-2 text-left text-sm text-t-primary hover:bg-accent-subtle transition-colors disabled:opacity-50"
                        >
                          {menuExporting === item.label || exporting === item.label.toLowerCase()
                            ? `Exporting ${item.label}...`
                            : item.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  onClick={async () => {
                    if (!showArtifactsPanel) {
                      await pageArtifacts.handleToggleArtifacts();
                      setShowArtifactsPanel(true);
                    } else {
                      setShowArtifactsPanel(false);
                    }
                  }}
                  className="p-1 text-t-secondary hover:text-accent transition-colors"
                  title="View artifacts (SQL, code, data)"
                >
                  <svg
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                  >
                    <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
                  </svg>
                </button>
              </>
            )}
            {/* Settings drawer toggle */}
            <button
              onClick={settingsOpen ? closeSettings : openSettings}
              className="p-1 transition-colors text-t-secondary hover:text-t-primary"
              aria-label="Settings"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                viewBox="0 0 24 24"
              >
                <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" />
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" />
              </svg>
            </button>
          </div>
        }
      />

      {/* Settings Drawer */}
      <SettingsDrawer
        open={settingsOpen}
        onClose={closeSettings}
        codeGenModel={codeGenModel}
        uiComposeModel={uiComposeModel}
        onCodeGenModelChange={handleCodeGenModelChange}
        onUiComposeModelChange={handleUiComposeModelChange}
        sandboxRuntime={sandboxRuntime}
        onSandboxRuntimeChange={handleRuntimeChange}
        ollamaModel={ollamaModel}
        onOllamaModelChange={setOllamaModel}
        defaultStyle={purpose}
        onDefaultStyleChange={setPurpose}
        schemaMode={schemaMode}
        onSchemaModeChange={setSchemaMode}
        isConnected={warehouse.isConnected}
        warehouseType={warehouse.warehouseType}
        warehouseId={warehouse.warehouseId}
        connectionLabel={
          warehouse.warehouseType
            ? `${warehouse.warehouseType} · ${warehouse.tableCount} tables`
            : null
        }
        savedConnections={warehouse.savedConnections}
        onConnect={(config, force) =>
          warehouse.connect(config as unknown as Parameters<typeof warehouse.connect>[0], force)
        }
        onDisconnect={warehouse.disconnect}
        onDeleteSaved={warehouse.deleteSaved}
        onRenameSaved={warehouse.renameSaved}
      />

      {/* Data Rail */}
      <DataRail
        visible={hasData}
        expanded={railExpanded}
        fullscreen={railFullscreen}
        onExpand={expandRail}
        onCollapse={collapseRail}
        onToggleFullscreen={toggleRailFullscreen}
      >
        <DataRailContent
          sourceType={warehouse.isConnected ? "warehouse" : isWorkbookMode ? "excel" : "csv"}
          sourceName={
            warehouse.isConnected
              ? `${warehouse.warehouseType ?? "Warehouse"} · ${warehouse.tableCount} tables`
              : (schema?.filename ?? "data")
          }
          schema={railSchema}
          allSchema={railAllSchema}
          moreColumns={railMoreColumns}
          profileChips={profileItems}
          sampleColumns={schema?.columns.map((c) => c.name)}
          sampleRows={schema?.sample_rows
            ?.slice(0, 5)
            .map((row) => schema.columns.map((c) => String(row[c.name] ?? "")))}
          sheets={excelMeta?.sheets.map((s) => ({ name: s.name, rows: s.rowCount }))}
          relationships={excelMeta?.relationships.map((r) => ({
            from: `${r.sourceSheet}.${r.sourceColumn}`,
            to: `${r.targetSheet}.${r.targetColumn}`,
          }))}
          tables={warehouse.tables.map((t) => ({
            name: t.name,
            rows: t.row_count_estimate?.toLocaleString() ?? "–",
          }))}
          warehouseSchemas={warehouse.tableSchemas}
          warehouseId={warehouse.warehouseId}
          fullscreen={railFullscreen}
          onRefreshSchema={onRefreshSchema}
          isRefreshing={isExtractingLocalSchema || warehouse.isConnecting}
        />
      </DataRail>

      {/* Main Content (blurs when any panel is open) */}
      <MainContent blurred={anyPanelOpen} railVisible={hasData}>
        <main id="main-content">
          {/* Saved Visualizations Panel */}
          {showSaved && (
            <div className="mb-6">
              <SavedVizsPanel
                onLoad={handleLoadViz}
                onRerun={handleRerunViz}
                onRefresh={handleRefreshViz}
                refreshKey={savedRefreshKey}
              />
            </div>
          )}

          {/* Loading states */}
          {loadingViz && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-accent">
              Loading saved visualization...
            </div>
          )}
          {rerunningViz && <RefreshProgress stage={refreshStage} />}

          {/* Sheet Picker (Excel flow) */}
          {showSheetPicker && excelMeta && (
            <SheetPicker
              excelId={excelMeta.excelId}
              filename={excelMeta.filename}
              sheets={excelMeta.sheets}
              relationships={excelMeta.relationships}
              onSheetSelected={handleUpload}
              onWorkbookSelected={handleWorkbookUpload}
              onCancel={cancelSheetPicker}
            />
          )}

          {/* Local File Browser */}
          <LocalFileBrowser
            open={showLocalBrowser}
            onClose={() => setShowLocalBrowser(false)}
            onSelect={handleLocalFileSelect}
            onSelectRemote={handleRemoteFileSelect}
            isExtracting={isExtractingLocalSchema}
          />

          {/* ═══ STATE 1: Connect Your Data ═══ */}
          {isState1 && warehouse.isConnecting && (
            <div
              className="flex flex-col items-center justify-center gap-3"
              style={{ minHeight: "calc(100vh - 56px)" }}
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
              <span className="text-sm text-t-secondary">Connecting to warehouse...</span>
              {warehouse.error && (
                <span className="text-sm text-error-text">{warehouse.error}</span>
              )}
            </div>
          )}
          {isState1 && !warehouse.isConnecting && (
            <div
              className="flex flex-col items-center gap-6"
              style={{
                minHeight: "calc(100vh - 56px)",
                paddingTop: "max(4.5vh, 24px)",
                paddingBottom: 48,
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const file = e.dataTransfer.files?.[0];
                if (file) {
                  armFromComposer();
                  processUploadFile(file);
                }
              }}
            >
              <div
                className="flex flex-col items-center gap-2 text-center"
                style={{ maxWidth: 640 }}
              >
                <h1
                  className="text-t-primary"
                  style={{
                    fontSize: "var(--text-hero)",
                    fontWeight: "var(--font-heading-weight)",
                    letterSpacing: "-1px",
                    lineHeight: 1.05,
                  }}
                >
                  Ask your data anything.
                </h1>
                <p
                  className="text-t-secondary"
                  style={{ fontSize: "var(--text-subhead)", lineHeight: 1.5, maxWidth: 540 }}
                >
                  Plain English in, a live dashboard out &mdash; the model never sees your rows.
                </p>
              </div>

              {/* Analyses still running server-side after this tab lost their
                  live view (reload / HMR) — one click to reattach to the stream. */}
              <ActiveRunsBanner
                runs={activeRuns.runs}
                onResume={resumeActiveRun}
                onDismiss={activeRuns.dismiss}
              />

              {/* THE primary action: question first, data attached to it.
                  Recents and saved connections live inside the Add-data menu. */}
              <AskComposer
                question={homeQuestion}
                onQuestionChange={setHomeQuestion}
                mode={queryMode}
                onModeChange={setQueryMode}
                attachedLabel={null}
                onSubmit={(q, m) => void handleGuardedQuery(q, m)}
                renderMenu={renderAddDataMenu}
              />

              <InlineConnectionForm
                visible={showWarehouseForm}
                onConnect={(config, force) =>
                  warehouse.connect(config as Parameters<typeof warehouse.connect>[0], force)
                }
              />

              {/* Examples ARE the payoff preview — click to run on the sample */}
              <ExampleCards onRun={runExample} />

              {/* Trust strip — the differentiator, promoted out of the footnote */}
              <div
                className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1.5 text-t-tertiary"
                style={{ fontSize: 13 }}
              >
                <span className="flex items-center gap-1.5">
                  <svg
                    className="h-3.5 w-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  >
                    <rect x="5" y="11" width="14" height="10" rx="2" />
                    <path d="M8 11V7a4 4 0 018 0v4" />
                  </svg>
                  Sealed &mdash; your data stays local
                </span>
                <span aria-hidden>&middot;</span>
                <span>Runs on local models or your own API key</span>
                <span aria-hidden>&middot;</span>
                <span>Sandboxed execution</span>
              </div>
            </div>
          )}

          {/* ═══ STATE 2: Ask ═══ */}
          {isState2 && (
            <div
              className="flex flex-col items-center"
              style={{ minHeight: "calc(100vh - 56px)", paddingTop: "calc(35vh - 56px)" }}
            >
              <div className="mb-6">
                <StyleSelector selected={purpose} onSelect={handleStyleChange} />
              </div>

              {llmWarning && (
                <div
                  className="mb-4 flex w-full max-w-[700px] items-center justify-between gap-3 border px-4 py-3 text-sm"
                  style={{
                    borderRadius: "var(--radius-card)",
                    borderColor: "var(--color-warning-border)",
                    backgroundColor: "var(--color-warning-bg)",
                    color: "var(--color-warning-text)",
                  }}
                >
                  <span>{llmWarning}</span>
                  <button
                    onClick={() => setLlmWarning(null)}
                    className="shrink-0 font-medium hover:opacity-70"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {sourceError && (
                <div
                  className="mb-4 flex w-full max-w-[700px] items-center justify-between gap-3 border px-4 py-3 text-sm"
                  role="alert"
                  style={{
                    borderRadius: "var(--radius-card)",
                    borderColor: "var(--color-error-border)",
                    backgroundColor: "var(--color-error-bg)",
                    color: "var(--color-error-text)",
                  }}
                >
                  <span>{sourceError}</span>
                  <button
                    onClick={clearSourceError}
                    className="shrink-0 font-medium hover:opacity-70"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {/* Same composer as the home screen — the data chip now shows the
                  attached source, and the menu becomes "Change data". */}
              <AskComposer
                question={homeQuestion}
                onQuestionChange={setHomeQuestion}
                mode={queryMode}
                onModeChange={setQueryMode}
                attachedLabel={datasetLabel}
                onSubmit={(q, m) => void handleGuardedQuery(q, m)}
                renderMenu={renderAddDataMenu}
                isLoading={isAnalyzing}
              />

              {/* Data-specific question suggestions — typewriter animation */}
              <SuggestionPills suggestions={suggestions} onSelect={handleGuardedQuery} />
            </div>
          )}

          {/* ResponsePanel: always mounted once data exists, hidden in States 1-2.
              This prevents mount/unmount cycles that abort in-flight streams. */}
          {hasData && (
            <div className={isState3 || isState4 ? "py-8" : "hidden"}>
              {/* Analysis history — shows previous question/result pairs */}
              {isState4 && analysisHistory.length > 1 && (
                <AnalysisHistory
                  entries={analysisHistory.slice(0, -1)}
                  onReplay={handleGuardedQuery}
                  onRestore={(entry) => {
                    // Spread to create a new reference so the useEffect in
                    // ResponsePanel fires even if restoring the same entry twice.
                    dispatch({
                      type: "LOAD_VIZ_SUCCESS",
                      question: entry.question,
                      spec: { ...entry.spec },
                      artifacts: null,
                    });
                  }}
                  onRemove={(ts) =>
                    setAnalysisHistory((prev) => prev.filter((e) => e.timestamp !== ts))
                  }
                />
              )}
              {/* Follow-up question input — ABOVE results for quick access */}
              {isState4 && !isAnalyzing && (
                <div className="mb-6 w-full max-w-[700px] mx-auto">
                  <QueryInput
                    onSubmit={handleGuardedQuery}
                    disabled={!hasData}
                    isLoading={isAnalyzing}
                    mode={queryMode}
                    onModeChange={setQueryMode}
                  />
                </div>
              )}
              <div ref={dashboardRef}>
                <ResponsePanel
                  csvId={csvId}
                  warehouseId={warehouse.warehouseId}
                  question={currentQuestion}
                  questionSeq={questionSeq}
                  mode={currentMode}
                  reattachRunId={reattachRunId}
                  onStreamEnd={handleStreamEndReattachAware}
                  onReattachFailed={handleReattachFailed}
                  loadedSpec={loadedSpec}
                  loadedArtifacts={loadedArtifacts}
                  schemaMode={schemaMode}
                  codeGenModel={codeGenModel}
                  uiComposeModel={uiComposeModel}
                  sandboxRuntime={sandboxRuntime}
                  purpose={purpose}
                  onRerun={handleRerunFromToolbar}
                  loadedVizId={loadedVizId}
                  onEffectiveCsvIdChange={setEffectiveCsvId}
                  onNotebookExportApiChange={setNotebookExportApi}
                  rerunCode={rerunCode}
                  rerunSql={rerunSql}
                  artifacts={pageArtifacts.artifacts}
                  setArtifacts={pageArtifacts.setArtifacts}
                  onAnalysisComplete={(entry) => {
                    setAnalysisHistory((prev) => [...prev, { ...entry, timestamp: Date.now() }]);
                    // ONE write path (M5-5e): the hook feeds Save/Export/
                    // Schedule and follow-up suggestions alike.
                    analysis.complete(entry.spec, entry.question);
                    const cid = effectiveCsvId ?? csvId;
                    if (cid) {
                      saveHistoryEntry(cid, entry.spec, entry.question).catch(() => {});
                    }
                  }}
                  onCost={(cost) => {
                    setLastCost(cost);
                    setSessionCost((s) => s + (cost.costUsd ?? 0));
                  }}
                />
              </div>
              {/* Follow-up suggestions — surfaces after each successful analysis */}
              {isState4 && !isAnalyzing && followUpSuggestions.length > 0 && (
                <div className="mt-6 w-full max-w-[700px] mx-auto">
                  <SuggestionPills
                    suggestions={followUpSuggestions}
                    onSelect={handleGuardedQuery}
                    title="Try next"
                  />
                </div>
              )}
            </div>
          )}
        </main>
      </MainContent>

      <CostFooter lastCost={lastCost} sessionCostUsd={sessionCost} />

      {/* Artifacts Panel — bottom sheet per design spec */}
      <ArtifactsPanel
        open={showArtifactsPanel}
        fullscreen={artifactsFullscreen}
        onClose={() => setShowArtifactsPanel(false)}
        onToggleFullscreen={() => setArtifactsFullscreen((f) => !f)}
        artifacts={pageArtifacts.artifacts}
        csvId={effectiveCsvId ?? csvId}
        sandboxRuntime={sandboxRuntime}
        onRerunSuccess={(newArtifacts) => pageArtifacts.setArtifacts(newArtifacts)}
        onRequestRerun={(edits) => {
          // Edit-and-Rerun: dispatch a fresh stream with the edited Python,
          // SQL, or both. Server skips the corresponding LLM step(s); the
          // standard pipeline rebuilds the dashboard.
          if (!currentQuestion) return;
          if (!edits.code && !edits.sql) return;
          dispatch({
            type: "RERUN_WITH_EDITS",
            question: currentQuestion,
            code: edits.code,
            sql: edits.sql,
          });
          setShowArtifactsPanel(false);
        }}
      />

      {/* Schedule popover — anchored to whichever button opened it. Auto-saves
          the viz first if needed, then renders cadence + auto-export options. */}
      {scheduleState.kind === "open" && (
        <SchedulePopover
          vizId={scheduleState.vizId}
          anchorRect={scheduleState.anchorRect}
          onClose={() => setScheduleState({ kind: "closed" })}
          onChanged={() => {
            // Bump the saved-vizs panel refresh key so its schedule indicators update
            handleSaved();
          }}
        />
      )}
    </>
  );
}
