"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import type { Spec } from "@json-render/react";
import { CSVUploadPanel } from "@/components/app/csv-upload-panel";
import { SheetPicker } from "@/components/app/sheet-picker";
import { SchemaPreview } from "@/components/app/schema-preview";
import { WorkbookPreview } from "@/components/app/workbook-preview";
import { WarehouseConnectPanel } from "@/components/app/warehouse-connect-panel";
import { QueryInput } from "@/components/app/query-input";
import { SavedVizsPanel } from "@/components/app/saved-vizs-panel";
import { SettingsPanel } from "@/components/app/settings-panel";

// Lazy-load ResponsePanel — it pulls in plotly.js, globe.gl, maplibre-gl, three.js etc.
// via the chart registry. Deferring avoids compiling ~300MB of deps on initial page load.
const ResponsePanel = dynamic(
  () => import("@/components/app/response-panel").then((m) => m.ResponsePanel),
  { ssr: false }
);
import { useCSVUpload } from "@/hooks/use-csv-upload";
import { useWarehouse } from "@/hooks/use-warehouse";
import { usePageState } from "@/hooks/use-page-state";
import type { SchemaMode } from "@/lib/types";
import { checkLlmReady, getLocalBackendConfig, loadViz, rerunViz, saveViz } from "@/lib/api";
import {
  CODE_GEN_MODEL,
  UI_COMPOSE_MODEL,
  DEFAULT_SANDBOX_RUNTIME,
  isValidRuntimeId,
} from "@/lib/constants";
import type { ModelId, SandboxRuntimeId } from "@/lib/constants";

export default function Home() {
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
    switchSheet,
    cancelSheetPicker,
    reset,
  } = useCSVUpload();
  const warehouse = useWarehouse();
  const [dataSourceMode, setDataSourceMode] = useState<"file" | "warehouse">("file");
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
  const [codeGenModel, setCodeGenModel] = useState<ModelId>(CODE_GEN_MODEL);
  const [uiComposeModel, setUiComposeModel] = useState<ModelId>(UI_COMPOSE_MODEL);
  const [sandboxRuntime, setSandboxRuntime] = useState<SandboxRuntimeId>(() => {
    if (typeof window !== "undefined") {
      const stored = localStorage.getItem("gud-sandbox-runtime");
      if (stored && isValidRuntimeId(stored)) return stored;
    }
    return DEFAULT_SANDBOX_RUNTIME;
  });
  const [ollamaModel, setOllamaModel] = useState<string | null>(null);
  const [loadedVizId, setLoadedVizId] = useState<string | null>(null);
  const [llmWarning, setLlmWarning] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rerunVizIdRef = useRef<string | null>(null);
  const openSettingsRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getLocalBackendConfig(controller.signal)
      .then((data) => {
        // Check all local backends for an active model
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
        openSettingsRef.current?.();
        return;
      }
      handleQuery(question);
    },
    [handleQuery]
  );

  const handleRuntimeChange = useCallback((r: SandboxRuntimeId) => {
    setSandboxRuntime(r);
    localStorage.setItem("gud-sandbox-runtime", r);
    // Persist to server so upload routes and warmup use the correct runtime
    fetch("/api/runtimes", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sandboxRuntime: r }),
    }).catch(() => {});
  }, []);

  const handleReset = useCallback(() => {
    reset();
    warehouse.reset();
    resetPage();
    setLoadedVizId(null);
    setDataSourceMode("file");
  }, [reset, warehouse, resetPage]);

  const handleLoadViz = useCallback(
    async (vizId: string) => {
      dispatch({ type: "LOAD_VIZ_START" });
      try {
        const data = await loadViz(vizId);

        // Server already parsed and stored the CSV — use the returned csvId
        if (data.workbook) {
          // Workbook mode — restore multi-sheet state
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
    // Reset file input so same file can be selected again
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
          // Fast path — schema matched, code re-executed successfully
          handleUpload(result.csvId, result.schema);
          dispatch({
            type: "RERUN_FAST_SUCCESS",
            spec: result.spec as unknown as Spec,
            artifacts: result.artifacts ?? null,
          });
          setLoadedVizId(vizId);
        } else {
          // Slow path — schemas differ, trigger full pipeline
          handleUpload(result.csvId, result.schema);
          dispatch({
            type: "RERUN_STREAM_START",
            question: result.question!,
            vizId,
          });
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

  // Auto-save after incompatible rerun completes the full pipeline
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

  return (
    <div className="min-h-screen">
      {/* Hidden file input for rerun */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.xlsx,.geojson,.json"
        className="hidden"
        onChange={handleRerunFileSelected}
      />

      <div className="mx-auto w-full max-w-5xl px-4 py-8 xl:max-w-[80vw]">
        <header className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-t-primary">Hermetic</h1>
            </div>
            <div className="flex items-center gap-3">
              <SettingsPanel
                codeGenModel={codeGenModel}
                uiComposeModel={uiComposeModel}
                onCodeGenModelChange={setCodeGenModel}
                onUiComposeModelChange={setUiComposeModel}
                sandboxRuntime={sandboxRuntime}
                onSandboxRuntimeChange={handleRuntimeChange}
                ollamaModel={ollamaModel}
                onOllamaModelChange={setOllamaModel}
                schemaMode={schemaMode}
                onSchemaModeChange={setSchemaMode}
                openRef={openSettingsRef}
              />
              <button
                onClick={toggleSaved}
                className={`text-sm font-medium transition-colors ${
                  showSaved ? "text-accent" : "text-t-secondary hover:text-t-primary"
                }`}
                style={{ transitionDuration: "var(--transition-speed)" }}
              >
                Saved
              </button>
              {isUploaded && excelMeta && !showSheetPicker && (
                <button
                  onClick={switchSheet}
                  className="text-sm text-accent hover:text-accent-hover transition-colors"
                  style={{ transitionDuration: "var(--transition-speed)" }}
                >
                  Switch sheet
                </button>
              )}
              {(isUploaded || showSheetPicker || warehouse.isConnected) && (
                <button
                  onClick={handleReset}
                  className="text-sm text-t-secondary hover:text-t-primary transition-colors"
                  style={{ transitionDuration: "var(--transition-speed)" }}
                >
                  New data source
                </button>
              )}
            </div>
          </div>
        </header>

        <main id="main-content" className="space-y-6">
          {showSaved && (
            <SavedVizsPanel
              onLoad={handleLoadViz}
              onRerun={handleRerunViz}
              refreshKey={savedRefreshKey}
            />
          )}

          {(loadingViz || rerunningViz) && (
            <div className="flex items-center gap-2 text-sm text-accent">
              {rerunningViz ? "Re-running with new data..." : "Loading saved visualization..."}
            </div>
          )}

          {showSheetPicker && excelMeta ? (
            <SheetPicker
              excelId={excelMeta.excelId}
              filename={excelMeta.filename}
              sheets={excelMeta.sheets}
              relationships={excelMeta.relationships}
              onSheetSelected={handleUpload}
              onWorkbookSelected={handleWorkbookUpload}
              onCancel={cancelSheetPicker}
            />
          ) : !isUploaded && !showSaved && !warehouse.isConnected ? (
            <div className="space-y-4">
              {/* Data source mode toggle */}
              <div className="flex gap-1 rounded-lg bg-surface-secondary p-1 max-w-xs">
                <button
                  onClick={() => setDataSourceMode("file")}
                  className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    dataSourceMode === "file"
                      ? "bg-surface-primary text-t-primary shadow-sm"
                      : "text-t-tertiary hover:text-t-secondary"
                  }`}
                >
                  Upload File
                </button>
                <button
                  onClick={() => setDataSourceMode("warehouse")}
                  className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    dataSourceMode === "warehouse"
                      ? "bg-surface-primary text-t-primary shadow-sm"
                      : "text-t-tertiary hover:text-t-secondary"
                  }`}
                >
                  Connect Warehouse
                </button>
              </div>

              {dataSourceMode === "file" ? (
                <CSVUploadPanel onUpload={handleUpload} onExcelSheets={handleExcelSheets} />
              ) : (
                <WarehouseConnectPanel
                  isConnected={warehouse.isConnected}
                  isConnecting={warehouse.isConnecting}
                  warehouseId={warehouse.warehouseId}
                  tables={warehouse.tables}
                  tableSchemas={warehouse.tableSchemas}
                  tableCount={warehouse.tableCount}
                  totalColumns={warehouse.totalColumns}
                  warehouseType={warehouse.warehouseType}
                  error={warehouse.error}
                  savedConnections={warehouse.savedConnections}
                  onConnect={warehouse.connect}
                  onDisconnect={warehouse.disconnect}
                  onDeleteSaved={warehouse.deleteSaved}
                />
              )}
            </div>
          ) : isUploaded || warehouse.isConnected ? (
            <>
              {isUploaded &&
                !warehouse.isConnected &&
                (isWorkbookMode && excelMeta ? (
                  <WorkbookPreview
                    filename={excelMeta.filename}
                    sheets={excelMeta.sheets}
                    relationships={excelMeta.relationships}
                    collapsed={questionSeq > 0}
                  />
                ) : (
                  schema && <SchemaPreview schema={schema} collapsed={questionSeq > 0} />
                ))}

              {warehouse.isConnected && (
                <WarehouseConnectPanel
                  isConnected={warehouse.isConnected}
                  isConnecting={warehouse.isConnecting}
                  warehouseId={warehouse.warehouseId}
                  tables={warehouse.tables}
                  tableSchemas={warehouse.tableSchemas}
                  tableCount={warehouse.tableCount}
                  totalColumns={warehouse.totalColumns}
                  warehouseType={warehouse.warehouseType}
                  error={warehouse.error}
                  savedConnections={warehouse.savedConnections}
                  onConnect={warehouse.connect}
                  onDisconnect={warehouse.disconnect}
                  onDeleteSaved={warehouse.deleteSaved}
                />
              )}

              {llmWarning && (
                <div
                  className="flex items-center justify-between gap-3 border px-4 py-3 text-sm"
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

              <QueryInput
                onSubmit={handleGuardedQuery}
                disabled={!isUploaded && !warehouse.isConnected}
                isLoading={isAnalyzing}
                initialValue={currentQuestion}
              />

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
                onRerun={handleRerunFromToolbar}
                loadedVizId={loadedVizId}
              />
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}
