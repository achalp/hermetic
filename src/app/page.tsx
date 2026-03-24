"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import type { Spec } from "@json-render/react";
import { SheetPicker } from "@/components/app/sheet-picker";
import { QueryInput } from "@/components/app/query-input";
import { SavedVizsPanel } from "@/components/app/saved-vizs-panel";

// New redesign components
import { TopBar } from "@/components/app/top-bar";
import { SourcePill } from "@/components/app/source-pill";
import { MainContent } from "@/components/app/main-content";
import { SettingsDrawer } from "@/components/app/settings-drawer";
import { DataRail } from "@/components/app/data-rail";
import { DataRailContent } from "@/components/app/data-rail-content";
import { SourceCards } from "@/components/app/source-cards";
import { SavedConnections } from "@/components/app/saved-connections";
import { InlineConnectionForm } from "@/components/app/inline-connection-form";
import { ProfileStrip } from "@/components/app/profile-strip";
import { StyleSelector } from "@/components/app/style-selector";
import { WorkingIndicator } from "@/components/app/working-indicator";

// Lazy-load ResponsePanel — it pulls in plotly.js, globe.gl, maplibre-gl, three.js etc.
const ResponsePanel = dynamic(
  () => import("@/components/app/response-panel").then((m) => m.ResponsePanel),
  { ssr: false }
);
import { useCSVUpload } from "@/hooks/use-csv-upload";
import { useWarehouse } from "@/hooks/use-warehouse";
import { usePageState } from "@/hooks/use-page-state";
import type { SchemaMode } from "@/lib/types";
import { DEFAULT_PURPOSE } from "@/lib/purpose-prompts";
import { checkLlmReady, getLocalBackendConfig, loadViz, rerunViz, saveViz } from "@/lib/api";
import {
  CODE_GEN_MODEL,
  UI_COMPOSE_MODEL,
  DEFAULT_SANDBOX_RUNTIME,
  AVAILABLE_MODELS,
  isValidRuntimeId,
} from "@/lib/constants";
import type { ModelId, SandboxRuntimeId } from "@/lib/constants";

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
    loadedSpec,
    loadedArtifacts,
    showSaved,
    savedRefreshKey,
    loadingViz,
    rerunningViz,
    pendingRerunVizId,
  } = pageState;
  const [schemaMode, setSchemaMode] = useState<SchemaMode>("metadata");
  const [purpose, setPurpose] = useState(DEFAULT_PURPOSE);
  const [codeGenModel, setCodeGenModel] = useState<ModelId>(CODE_GEN_MODEL);
  const [uiComposeModel, setUiComposeModel] = useState<ModelId>(UI_COMPOSE_MODEL);
  const [sandboxRuntime, setSandboxRuntime] = useState<SandboxRuntimeId>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("gud-sandbox-runtime");
      if (stored && isValidRuntimeId(stored)) return stored;
    }
    return DEFAULT_SANDBOX_RUNTIME;
  });
  const [, setOllamaModel] = useState<string | null>(null);
  const [loadedVizId, setLoadedVizId] = useState<string | null>(null);
  const [llmWarning, setLlmWarning] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const rerunVizIdRef = useRef<string | null>(null);

  // ── New redesign state ──────────────────────────────────────
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [railExpanded, setRailExpanded] = useState(false);
  const [railFullscreen, setRailFullscreen] = useState(false);
  const [showWarehouseForm, setShowWarehouseForm] = useState(false);
  const [workingStatus, setWorkingStatus] = useState("Analyzing...");

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
    async (question: string) => {
      setLlmWarning(null);
      const readiness = await checkLlmReady();
      if (!readiness.ready) {
        setLlmWarning(readiness.message ?? "LLM is not available.");
        openSettings();
        return;
      }
      handleQuery(question);
    },
    [handleQuery, openSettings]
  );

  const handleRuntimeChange = useCallback((r: SandboxRuntimeId) => {
    setSandboxRuntime(r);
    localStorage.setItem("gud-sandbox-runtime", r);
    fetch("/api/runtimes", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sandboxRuntime: r }),
    }).catch(() => {});
  }, []);
  // Suppress unused warning — will be wired to settings drawer runtime selector
  void handleRuntimeChange;

  const handleReset = useCallback(() => {
    reset();
    warehouse.reset();
    resetPage();
    setLoadedVizId(null);
    setShowWarehouseForm(false);
  }, [reset, warehouse, resetPage]);

  const handleLoadViz = useCallback(
    async (vizId: string) => {
      dispatch({ type: "LOAD_VIZ_START" });
      try {
        const data = await loadViz(vizId);
        if (data.workbook) {
          loadWorkbookUpload(
            data.csvId,
            data.schema,
            data.workbook.filename,
            data.workbook.sheetInfo,
            data.workbook.relationships
          );
        } else {
          handleUpload(data.csvId, data.schema);
        }
        dispatch({
          type: "LOAD_VIZ_SUCCESS",
          question: data.meta.question,
          spec: data.spec as unknown as Spec,
          artifacts: data.artifacts ?? null,
        });
        setLoadedVizId(vizId);
      } catch (err) {
        console.error("Load viz failed:", err);
        dispatch({ type: "LOAD_VIZ_ERROR" });
      }
    },
    [handleUpload, loadWorkbookUpload, dispatch]
  );

  const handleRerunViz = useCallback((vizId: string) => {
    rerunVizIdRef.current = vizId;
    if (fileInputRef.current) fileInputRef.current.value = "";
    fileInputRef.current?.click();
  }, []);

  const handleRerunFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      const vizId = rerunVizIdRef.current;
      if (!file || !vizId) return;
      window.scrollTo({ top: 0, behavior: "smooth" });
      dispatch({ type: "RERUN_START" });
      try {
        const result = await rerunViz(vizId, file, sandboxRuntime);
        if (result.schemaMatch) {
          handleUpload(result.csvId, result.schema);
          dispatch({
            type: "RERUN_FAST_SUCCESS",
            spec: result.spec as unknown as Spec,
            artifacts: result.artifacts ?? null,
          });
          setLoadedVizId(vizId);
        } else {
          handleUpload(result.csvId, result.schema);
          dispatch({ type: "RERUN_STREAM_START", question: result.question!, vizId });
          setLoadedVizId(vizId);
        }
      } catch (err) {
        console.error("Rerun failed:", err);
        dispatch({ type: "RERUN_ERROR" });
      }
    },
    [dispatch, handleUpload, sandboxRuntime]
  );

  const handleRerunFromToolbar = useCallback(() => {
    if (loadedVizId) handleRerunViz(loadedVizId);
  }, [loadedVizId, handleRerunViz]);

  // Auto-save after incompatible rerun
  useEffect(() => {
    if (!isAnalyzing && pendingRerunVizId && csvId && loadedSpec) {
      saveViz(csvId, loadedSpec, currentQuestion ?? "Analysis", pendingRerunVizId)
        .then(() => {
          dispatch({ type: "CLEAR_PENDING_RERUN" });
          dispatch({ type: "VIZ_SAVED" });
        })
        .catch((err) => {
          console.error("Auto-save after rerun failed:", err);
          dispatch({ type: "CLEAR_PENDING_RERUN" });
        });
    }
  }, [isAnalyzing, pendingRerunVizId, csvId, loadedSpec, currentQuestion, dispatch]);

  // Working status animation — all setState calls are inside async callbacks (setTimeout)
  useEffect(() => {
    if (!isAnalyzing) return;
    // Reset on every new analysis via setTimeout(0) to satisfy lint (not synchronous in effect body)
    const t0 = setTimeout(() => setWorkingStatus("Analyzing..."), 0);
    const t1 = setTimeout(() => setWorkingStatus("Composing..."), 1500);
    const t2 = setTimeout(() => setWorkingStatus("Almost done..."), 3000);
    return () => {
      clearTimeout(t0);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [isAnalyzing, questionSeq]);

  // ── Derived state ───────────────────────────────────────────
  const hasData = isUploaded || warehouse.isConnected;
  const isState1 = !hasData && !showSheetPicker && !showSaved && !loadingViz && !rerunningViz;
  const isState2 = hasData && !isAnalyzing && !loadedSpec;
  const isState3 = isAnalyzing;
  const isState4 = hasData && !isAnalyzing && !!loadedSpec;

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

  // Source label for top bar pill
  const sourceLabel = schema
    ? `✓ ${schema.filename ?? "data"} · ${schema.row_count.toLocaleString()} rows`
    : warehouse.isConnected
      ? `✓ ${warehouse.warehouseType ?? "Warehouse"} · ${warehouse.tableCount} tables`
      : "";

  // Build data rail schema from CSV schema or warehouse
  const railSchema = schema?.columns.slice(0, 8).map((c) => ({
    name: c.name,
    type: c.dtype === "number" ? "number" : c.dtype === "date" ? "date" : "text",
    sample: c.sample_values?.[0] ?? "",
  }));
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
          if (!file) return;
          const formData = new FormData();
          formData.append("file", file);
          fetch("/api/upload", { method: "POST", body: formData })
            .then((res) => res.json())
            .then((data) => {
              if (data.excel_id) {
                handleExcelSheets(data.excel_id, file.name, data.sheets, data.relationships ?? []);
              } else if (data.csv_id && data.schema) {
                handleUpload(data.csv_id, data.schema);
              }
            })
            .catch((err) => console.error("Upload failed:", err));
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
            {showSaved && (
              <button
                onClick={toggleSaved}
                className="text-sm font-medium text-accent"
                style={{ transitionDuration: "var(--transition-speed)" }}
              >
                Saved
              </button>
            )}
            {!showSaved && (
              <button
                onClick={toggleSaved}
                className="text-sm font-medium text-t-secondary hover:text-t-primary transition-colors"
                style={{ transitionDuration: "var(--transition-speed)" }}
              >
                Saved
              </button>
            )}
            {hasData && (
              <button
                onClick={handleReset}
                className="text-sm text-t-secondary hover:text-t-primary transition-colors"
                style={{ transitionDuration: "var(--transition-speed)" }}
              >
                New
              </button>
            )}
            {/* Gear icon */}
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
        onCodeGenModelChange={setCodeGenModel}
        onUiComposeModelChange={setUiComposeModel}
        availableModels={AVAILABLE_MODELS.map((m) => ({ id: m.id, label: m.label }))}
        defaultStyle={purpose}
        onDefaultStyleChange={setPurpose}
        schemaMode={schemaMode}
        onSchemaModeChange={setSchemaMode}
        isConnected={warehouse.isConnected}
        warehouseType={warehouse.warehouseType}
        connectionLabel={
          warehouse.warehouseType
            ? `${warehouse.warehouseType} · ${warehouse.tableCount} tables`
            : null
        }
        savedConnections={warehouse.savedConnections.map((c) => ({
          id: c.id,
          type: c.config.type,
          name: c.label,
          host: "host" in c.config ? c.config.host : c.config.type,
        }))}
        onConnect={(config) =>
          warehouse.connect(config as unknown as Parameters<typeof warehouse.connect>[0])
        }
        onDisconnect={warehouse.disconnect}
        onDeleteSaved={warehouse.deleteSaved}
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
          moreColumns={railMoreColumns}
          profileChips={profileItems}
          sampleColumns={schema?.columns.slice(0, 5).map((c) => c.name)}
          sampleRows={schema?.sample_rows
            ?.slice(0, 3)
            .map((row) => schema.columns.slice(0, 5).map((c) => String(row[c.name] ?? "")))}
          sheets={excelMeta?.sheets.map((s) => ({ name: s.name, rows: s.rowCount }))}
          relationships={excelMeta?.relationships.map((r) => ({
            from: `${r.sourceSheet}.${r.sourceColumn}`,
            to: `${r.targetSheet}.${r.targetColumn}`,
          }))}
          tables={warehouse.tables.map((t) => ({
            name: t.name,
            rows: t.row_count_estimate?.toLocaleString() ?? "–",
          }))}
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
                refreshKey={savedRefreshKey}
              />
            </div>
          )}

          {/* Loading states */}
          {(loadingViz || rerunningViz) && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-accent">
              {rerunningViz ? "Re-running with new data..." : "Loading saved visualization..."}
            </div>
          )}

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

          {/* ═══ STATE 1: Connect Your Data ═══ */}
          {isState1 && (
            <div
              className="flex flex-col items-center justify-center gap-8"
              style={{ minHeight: "calc(100vh - 56px)" }}
            >
              <h1
                className="text-center text-t-primary"
                style={{
                  fontSize: 36,
                  fontWeight: "var(--font-heading-weight)",
                  letterSpacing: "-0.5px",
                }}
              >
                What&apos;s hiding in your data?
              </h1>

              <SourceCards
                onFileDrop={() => {
                  if (uploadInputRef.current) uploadInputRef.current.value = "";
                  uploadInputRef.current?.click();
                }}
                onWarehouseClick={() => setShowWarehouseForm((v) => !v)}
              />

              <SavedConnections
                connections={warehouse.savedConnections.map((c) => ({
                  id: c.id,
                  type: c.config.type,
                  name: c.label,
                  host: "host" in c.config ? c.config.host : c.config.type,
                }))}
                onConnect={(id) => {
                  const saved = warehouse.savedConnections.find((c) => c.id === id);
                  if (saved) warehouse.connect(saved.config);
                }}
              />

              <InlineConnectionForm
                visible={showWarehouseForm}
                onConnect={(config) =>
                  warehouse.connect(config as Parameters<typeof warehouse.connect>[0])
                }
              />

              <div className="text-center text-sm text-t-tertiary">
                🔒 Sealed. Your data stays local.
              </div>
            </div>
          )}

          {/* ═══ STATE 2: Ask ═══ */}
          {isState2 && (
            <div
              className="flex flex-col items-center justify-center"
              style={{ minHeight: "calc(100vh - 56px)", paddingBottom: 80 }}
            >
              <ProfileStrip items={profileItems} />

              <div className="mb-6">
                <StyleSelector selected={purpose} onSelect={setPurpose} />
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

              <div className="w-full max-w-[700px]">
                <QueryInput
                  onSubmit={handleGuardedQuery}
                  disabled={!hasData}
                  isLoading={isAnalyzing}
                  initialValue={currentQuestion}
                />
              </div>
            </div>
          )}

          {/* ═══ STATE 3: Working ═══ */}
          {isState3 && <WorkingIndicator status={workingStatus} />}

          {/* ═══ STATE 4: Results ═══ */}
          {isState4 && (
            <div className="py-8">
              <ResponsePanel
                csvId={csvId}
                warehouseId={warehouse.warehouseId}
                question={currentQuestion}
                questionSeq={questionSeq}
                onStreamEnd={handleStreamEnd}
                loadedSpec={loadedSpec}
                loadedArtifacts={loadedArtifacts}
                onSaved={handleSaved}
                schemaMode={schemaMode}
                codeGenModel={codeGenModel}
                uiComposeModel={uiComposeModel}
                sandboxRuntime={sandboxRuntime}
                purpose={purpose}
                onRerun={handleRerunFromToolbar}
                loadedVizId={loadedVizId}
              />
            </div>
          )}
        </main>
      </MainContent>
    </>
  );
}
