"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type { Spec } from "@json-render/react";
import { CSVUploadPanel } from "@/components/app/csv-upload-panel";
import { SheetPicker } from "@/components/app/sheet-picker";
import { SchemaPreview } from "@/components/app/schema-preview";
import { WorkbookPreview } from "@/components/app/workbook-preview";
import { QueryInput } from "@/components/app/query-input";
import { ResponsePanel } from "@/components/app/response-panel";
import { SavedVizsPanel } from "@/components/app/saved-vizs-panel";
import { SettingsPanel } from "@/components/app/settings-panel";
import { useCSVUpload } from "@/hooks/use-csv-upload";
import { usePageState } from "@/hooks/use-page-state";
import type { SchemaMode } from "@/lib/types";
import { getOllamaConfig, loadViz, rerunViz, saveViz } from "@/lib/api";
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rerunVizIdRef = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    getOllamaConfig(controller.signal)
      .then((data) => {
        if (data.ollama?.enabled && data.ollama?.activeModel) {
          setOllamaModel(data.ollama.activeModel);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const handleRuntimeChange = useCallback((r: SandboxRuntimeId) => {
    setSandboxRuntime(r);
    localStorage.setItem("gud-sandbox-runtime", r);
  }, []);

  const handleReset = useCallback(() => {
    reset();
    resetPage();
    setLoadedVizId(null);
  }, [reset, resetPage]);

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

      <div className="mx-auto max-w-5xl px-4 py-8">
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
              {(isUploaded || showSheetPicker) && (
                <button
                  onClick={handleReset}
                  className="text-sm text-t-secondary hover:text-t-primary transition-colors"
                  style={{ transitionDuration: "var(--transition-speed)" }}
                >
                  Upload new file
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
          ) : !isUploaded && !showSaved ? (
            <CSVUploadPanel onUpload={handleUpload} onExcelSheets={handleExcelSheets} />
          ) : isUploaded ? (
            <>
              {isWorkbookMode && excelMeta ? (
                <WorkbookPreview
                  filename={excelMeta.filename}
                  sheets={excelMeta.sheets}
                  relationships={excelMeta.relationships}
                  collapsed={questionSeq > 0}
                />
              ) : (
                schema && <SchemaPreview schema={schema} collapsed={questionSeq > 0} />
              )}

              <QueryInput
                onSubmit={handleQuery}
                disabled={!isUploaded}
                isLoading={isAnalyzing}
                initialValue={currentQuestion}
              />

              <ResponsePanel
                csvId={csvId}
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
