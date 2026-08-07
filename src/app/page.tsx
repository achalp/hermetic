"use client";

/**
 * The composition root of the app (rebuilt in M5/F1): every piece of page
 * behavior lives in a dedicated hook, every region of the layout in a
 * dedicated component. This file only wires them together — if you're adding
 * logic here, it probably belongs in one of the hooks below.
 */
import { useState, useRef } from "react";
import { SheetPicker } from "@/app/components/sheet-picker";
import { type QueryMode } from "@/app/components/query-input";
import { SavedVizsPanel } from "@/app/components/saved-vizs-panel";
import { MainContent } from "@/app/components/main-content";
import { LocalFileBrowser } from "@/app/components/local-file-browser";
import { RefreshProgress } from "@/app/components/refresh-progress";
import { CostFooter, type CostInfo } from "@/app/components/cost-footer";
import { type HistoryEntry } from "@/app/components/analysis-history";
import { HomeTopBar } from "@/app/components/results-toolbar";
import { ResultsRegion } from "@/app/components/results-region";
import { PageChrome } from "@/app/components/page-chrome";
import { WarehouseConnecting, HomeHero, AskScreen } from "@/app/components/home/home-screens";
import { buildDatasetLabel, buildSourceLabel } from "@/app/components/data-rail-derive";
import type { NotebookExportApi } from "@/app/components/notebook-view";
import { useCSVUpload } from "@/hooks/use-csv-upload";
import { useWarehouse } from "@/hooks/use-warehouse";
import { usePageState } from "@/hooks/use-page-state";
import { useVizActions } from "@/hooks/use-viz-actions";
import { useSourceSelect } from "@/hooks/use-source-select";
import { useHistoryRestore } from "@/hooks/use-history-restore";
import { useArtifacts } from "@/hooks/use-artifacts";
import { useSuggestions } from "@/hooks/use-suggestions";
import { useCurrentAnalysis } from "@/hooks/use-current-analysis";
import { useModelSettings } from "@/hooks/use-model-settings";
import { useRecentsList } from "@/hooks/use-recents-list";
import { useReattach } from "@/hooks/use-reattach";
import { useAnalysisActions } from "@/hooks/use-analysis-actions";
import { useBrowserNav } from "@/hooks/use-browser-nav";
import { usePanels } from "@/hooks/use-panels";
import { useHomeComposer } from "@/hooks/use-home-composer";
import type { SchemaMode } from "@/lib/contracts/data-schema";
import { DEFAULT_PURPOSE } from "@/lib/purpose-prompts";
import { saveHistoryEntry } from "@/app/lib/api";

export default function Home() {
  // ── Source & page state ─────────────────────────────────────
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
    showSaved,
    savedRefreshKey,
    loadingViz,
    rerunningViz,
    pendingRerunVizId,
    loadedVizId,
    refreshStage,
  } = pageState;

  const [schemaMode, setSchemaMode] = useState<SchemaMode>("metadata");
  // Composer sight (composer-sight spec §1) — user choice like schema mode.
  const [composerSight, setComposerSight] = useState<string>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("hermetic_composer_sight");
      if (stored === "sighted" || stored === "blind") return stored;
    }
    return "blind";
  });
  const handleComposerSightChange = (m: string) => {
    setComposerSight(m === "sighted" ? "sighted" : "blind");
    try {
      localStorage.setItem("hermetic_composer_sight", m);
    } catch {}
  };
  const [purpose, setPurpose] = useState(DEFAULT_PURPOSE);
  // Model / runtime selections, persisted to localStorage — use-model-settings.
  const models = useModelSettings();
  const [llmWarning, setLlmWarning] = useState<string | null>(null);
  // Lifted here from QueryInput so suggestion pills and history replays
  // inherit whichever mode the user toggled the input to.
  const [queryMode, setQueryMode] = useState<QueryMode>("ask");
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const dashboardRef = useRef<HTMLDivElement>(null);

  // ONE holder for the analysis on screen (M5-5e) — replaces currentSpecRef,
  // currentQuestionRef, and lastCompleteSpec plus their hand-rolled syncs.
  const analysis = useCurrentAnalysis({ loadedSpec, currentQuestion, isAnalyzing });

  // Panel chrome open/closed state + mutual exclusion — use-panels.
  const panels = usePanels();

  // Cost footer: last analysis cost + running session total.
  const [lastCost, setLastCost] = useState<CostInfo | null>(null);
  const [sessionCost, setSessionCost] = useState(0);
  const [showWarehouseForm, setShowWarehouseForm] = useState(false);
  // Notebook export handlers registered by the active NotebookView (switches
  // the Export menu to notebook formats).
  const [notebookExportApi, setNotebookExportApi] = useState<NotebookExportApi | null>(null);
  const [effectiveCsvId, setEffectiveCsvId] = useState<string | null>(null);
  const [analysisHistory, setAnalysisHistory] = useState<HistoryEntry[]>([]);
  // History id of the LIVE analysis on screen (from the background save) —
  // the reconstruction key that makes the results URL paste-able.
  const [liveHistoryId, setLiveHistoryId] = useState<string | null>(null);

  // Page-level artifacts — uses effectiveCsvId reported by ResponsePanel
  const pageArtifacts = useArtifacts({ csvId: effectiveCsvId });

  // Guarded query, style re-ask, save/export/schedule — use-analysis-actions.
  const actions = useAnalysisActions({
    csvId: effectiveCsvId ?? csvId,
    analysis,
    dashboardRef,
    onSaved: handleSaved,
    handleQuery,
    queryMode,
    currentQuestion,
    currentMode,
    isAnalyzing,
    loadedVizId,
    setPurpose,
    setLlmWarning,
    openSettings: panels.openSettings,
  });
  const { handleGuardedQuery } = actions;

  // URL-driven history restore / re-run (?restore= / ?rerun_history=) —
  // see use-history-restore.ts.
  useHistoryRestore({
    dispatch,
    handleUpload,
    warehouseId: warehouse.warehouseId,
    sandboxRuntime: models.sandboxRuntime,
  });

  // Local/remote/upload/sample source selection — see use-source-select.ts.
  const source = useSourceSelect({ handleUpload, handleExcelSheets });

  // Recent sources (uploads / local / cloud + saved warehouses) — use-recents-list.
  const { recentItems, reopenRecent } = useRecentsList({
    warehouse,
    handleRemoteFileSelect: source.handleRemoteFileSelect,
    handleLocalFileSelect: source.handleLocalFileSelect,
  });

  // Schema-sidebar "refresh" — re-read the current source's schema, ignoring the
  // cache. Only cache-backed sources (warehouse / remote Parquet) offer it; an
  // uploaded CSV has no source to re-read.
  const onRefreshSchema = warehouse.isConnected
    ? warehouse.refresh
    : source.hasRemoteSource
      ? source.refreshRemote
      : undefined;

  const handleReset = () => {
    reset();
    warehouse.reset();
    resetPage(); // RESET returns to initialState → loadedVizId/refreshStage null
    setShowWarehouseForm(false);
    source.resetSourceSelect();
  };

  // Saved-viz load / re-run / refresh + auto-save-after-rerun — see
  // use-viz-actions.ts. Owns the hidden rerun file input's ref.
  const viz = useVizActions({
    dispatch,
    handleUpload,
    loadWorkbookUpload,
    warehouseId: warehouse.warehouseId,
    sandboxRuntime: models.sandboxRuntime,
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

  // ── Derived state ───────────────────────────────────────────
  const hasData = isUploaded || warehouse.isConnected;
  const isState1 = !hasData && !showSheetPicker && !showSaved && !loadingViz && !rerunningViz;
  // hasResults: true when there are results to display (queried or loaded a viz)
  const hasResults = questionSeq > 0 || !!loadedSpec;
  const isState2 = hasData && !isAnalyzing && !hasResults;
  const isState3 = isAnalyzing;
  const isState4 = hasData && !isAnalyzing && hasResults;

  // Browser back/forward walks the app's own transitions (use-browser-nav):
  // results -> data -> home, with results URL-addressable via ?restore=.
  useBrowserNav({
    address: isState4
      ? {
          view: "results",
          entryId: loadedVizId ?? liveHistoryId,
          csvId: effectiveCsvId ?? csvId,
        }
      : isState2
        ? { view: "data", csvId: effectiveCsvId ?? csvId }
        : { view: "home" },
    suspended: isAnalyzing || loadingViz || rerunningViz,
    onPopTo: (target) => {
      if (target === "home") {
        handleReset();
      } else if (target === "data") {
        setLiveHistoryId(null);
        dispatch({ type: "NEW_ANALYSIS" });
      }
      // "results" forward-nav: only restorable content reloads, handled by
      // the restore deep-link on full navigation; in-SPA forward to an
      // unsaved result is a no-op by design.
    },
  });

  // Reconnect to a run that survived a client drop — use-reattach.
  const reattach = useReattach({
    enabled: isState1,
    handleUpload,
    handleQuery,
    handleStreamEnd,
    currentQuestion,
    currentMode,
  });

  // Ask-first composer wiring (home + State 2) — use-home-composer.
  const composer = useHomeComposer({
    isState2,
    queryMode,
    setQueryMode,
    handleGuardedQuery,
    uploadInputRef,
    sandboxRuntime: models.sandboxRuntime,
    setShowLocalBrowser: source.setShowLocalBrowser,
    setShowWarehouseForm,
    warehouse,
    handleSampleData: source.handleSampleData,
    reopenRecent,
  });

  const composerWiring = {
    question: composer.homeQuestion,
    onQuestionChange: composer.setHomeQuestion,
    mode: queryMode,
    onModeChange: setQueryMode,
    onSubmit: (q: string, m: QueryMode) => void handleGuardedQuery(q, m),
  };
  const menuWiring = {
    recents: recentItems,
    savedConnections: composer.savedConnectionItems,
    onOpenRecent: composer.composerOpenRecent,
    onUpload: composer.composerUpload,
    onLocalBrowse: composer.composerLocalBrowse,
    onNewWarehouse: composer.composerNewWarehouse,
    onSavedConnect: composer.composerSavedConnect,
    onSample: composer.composerSample,
  };

  // ── Render ──────────────────────────────────────────────────
  return (
    <>
      {/* Hidden file inputs: saved-viz rerun; initial upload (composer) */}
      <input
        ref={viz.fileInputRef}
        type="file"
        accept=".csv,.xlsx,.geojson,.json"
        className="hidden"
        onChange={viz.handleRerunFileSelected}
      />
      <input
        ref={uploadInputRef}
        type="file"
        accept=".csv,.xlsx,.geojson,.json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) source.processUploadFile(file);
        }}
      />

      {/* Top Bar: current question (State 4) / source pill, and the toolbar */}
      <HomeTopBar
        onLogoClick={handleReset}
        hasData={hasData}
        isState1={isState1}
        sourceLabel={buildSourceLabel(schema, warehouse)}
        toolbar={{
          isState4,
          showSaved,
          onToggleSaved: toggleSaved,
          purpose,
          onStyleChange: actions.handleStyleChange,
          loadedVizId,
          rerunningViz,
          onRerun: viz.handleRefreshFromToolbar,
          saveExport: actions.saveExport,
          scheduleKind: actions.schedule.scheduleState.kind,
          onScheduleClick: actions.schedule.handleScheduleClick,
          notebookExportApi,
          onExportSlides: actions.handleExportSlides,
          onToggleArtifacts: async () => {
            if (!panels.showArtifactsPanel) {
              await pageArtifacts.handleToggleArtifacts();
              panels.setShowArtifactsPanel(true);
            } else {
              panels.setShowArtifactsPanel(false);
            }
          },
          settingsOpen: panels.settingsOpen,
          onOpenSettings: panels.openSettings,
          onCloseSettings: panels.closeSettings,
        }}
      />

      {/* Settings drawer, data rail, artifacts sheet, schedule popover */}
      <PageChrome
        panels={panels}
        models={models}
        purpose={purpose}
        onPurposeChange={setPurpose}
        schemaMode={schemaMode}
        onSchemaModeChange={setSchemaMode}
        composerSight={composerSight}
        onComposerSightChange={handleComposerSightChange}
        verifiability={
          (
            (analysis.freshSpec ?? loadedSpec)?.state as
              | { __verifiability?: import("@/app/components/verify-tab").VerifiabilityPayload }
              | undefined
          )?.__verifiability ?? null
        }
        historyId={loadedVizId ?? liveHistoryId}
        warehouse={warehouse}
        hasData={hasData}
        schema={schema}
        excelMeta={excelMeta}
        isWorkbookMode={isWorkbookMode}
        onRefreshSchema={onRefreshSchema}
        isRefreshingSchema={source.isExtractingLocalSchema || warehouse.isConnecting}
        pageArtifacts={pageArtifacts}
        artifactsCsvId={effectiveCsvId ?? csvId}
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
          panels.setShowArtifactsPanel(false);
        }}
        scheduleState={actions.schedule.scheduleState}
        onCloseSchedule={() => actions.schedule.setScheduleState({ kind: "closed" })}
        onScheduleChanged={handleSaved}
      />

      {/* Main Content (blurs when any panel is open) */}
      <MainContent blurred={panels.anyPanelOpen} railVisible={hasData}>
        <main id="main-content">
          {/* Saved Visualizations Panel */}
          {showSaved && (
            <div className="mb-6">
              <SavedVizsPanel
                onLoad={viz.handleLoadViz}
                onRerun={viz.handleRerunViz}
                onRefresh={viz.handleRefreshViz}
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
            open={source.showLocalBrowser}
            onClose={() => source.setShowLocalBrowser(false)}
            onSelect={source.handleLocalFileSelect}
            onSelectRemote={source.handleRemoteFileSelect}
            isExtracting={source.isExtractingLocalSchema}
          />

          {/* ═══ STATE 1: Connect Your Data ═══ */}
          {isState1 && warehouse.isConnecting && <WarehouseConnecting error={warehouse.error} />}
          {isState1 && !warehouse.isConnecting && (
            <HomeHero
              composer={composerWiring}
              menu={menuWiring}
              purpose={purpose}
              onStyleChange={actions.handleStyleChange}
              onDropFile={(file) => {
                composer.armFromComposer();
                source.processUploadFile(file);
              }}
              activeRuns={reattach.activeRuns.runs}
              onResumeRun={reattach.resumeActiveRun}
              onDismissRun={reattach.activeRuns.dismiss}
              showWarehouseForm={showWarehouseForm}
              onConnect={(config, force) =>
                warehouse.connect(config as Parameters<typeof warehouse.connect>[0], force)
              }
              onRunExample={composer.runExample}
            />
          )}

          {/* ═══ STATE 2: Ask ═══ */}
          {isState2 && (
            <AskScreen
              composer={composerWiring}
              menu={menuWiring}
              attachedLabel={buildDatasetLabel(schema, warehouse)}
              isAnalyzing={isAnalyzing}
              purpose={purpose}
              onStyleChange={actions.handleStyleChange}
              llmWarning={llmWarning}
              onDismissLlmWarning={() => setLlmWarning(null)}
              sourceError={source.sourceError}
              onDismissSourceError={source.clearSourceError}
              suggestions={suggestions}
              onSelectSuggestion={handleGuardedQuery}
            />
          )}

          {/* ═══ STATES 3+4: analysis history, ResponsePanel, follow-ups ═══ */}
          <ResultsRegion
            hasData={hasData}
            isState3={isState3}
            isState4={isState4}
            queryMode={queryMode}
            setQueryMode={setQueryMode}
            analysisHistory={analysisHistory}
            onRemoveHistoryEntry={(ts) =>
              setAnalysisHistory((prev) => prev.filter((e) => e.timestamp !== ts))
            }
            onGuardedQuery={handleGuardedQuery}
            pageState={pageState}
            dispatch={dispatch}
            dashboardRef={dashboardRef}
            csvId={csvId}
            warehouseId={warehouse.warehouseId}
            reattach={reattach}
            schemaMode={schemaMode}
            composerSight={composerSight}
            verifiability={
              (
                (analysis.freshSpec ?? loadedSpec)?.state as
                  | {
                      __verifiability?: import("@/app/components/verify-tab").VerifiabilityPayload;
                    }
                  | undefined
              )?.__verifiability ?? null
            }
            historyId={loadedVizId ?? liveHistoryId}
            models={models}
            purpose={purpose}
            onRerun={viz.handleRerunFromToolbar}
            onEffectiveCsvIdChange={setEffectiveCsvId}
            onNotebookExportApiChange={setNotebookExportApi}
            pageArtifacts={pageArtifacts}
            onAnalysisComplete={(entry) => {
              setAnalysisHistory((prev) => [...prev, { ...entry, timestamp: Date.now() }]);
              // ONE write path (M5-5e): the hook feeds Save/Export/Schedule
              // and follow-up suggestions alike.
              analysis.complete(entry.spec, entry.question);
              const cid = effectiveCsvId ?? csvId;
              if (cid) {
                // The returned id is the results URL's reconstruction key —
                // useBrowserNav upgrades ?view=results to ?restore=<id>.
                saveHistoryEntry(cid, entry.spec, entry.question)
                  .then((r) => {
                    if (r.meta?.id) setLiveHistoryId(r.meta.id);
                  })
                  .catch(() => {});
              }
            }}
            onCost={(cost) => {
              setLastCost(cost);
              setSessionCost((s) => s + (cost.costUsd ?? 0));
            }}
            followUpSuggestions={followUpSuggestions}
          />
        </main>
      </MainContent>

      <CostFooter lastCost={lastCost} sessionCostUsd={sessionCost} />
    </>
  );
}
