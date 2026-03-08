"use client";

import { useState, useCallback, useEffect } from "react";
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
import { getOllamaConfig, loadViz, uploadFile } from "@/lib/api";
import {
  MAX_SAMPLE_ROWS,
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
  }, [reset, resetPage]);

  const handleLoadViz = useCallback(
    async (vizId: string) => {
      dispatch({ type: "LOAD_VIZ_START" });
      try {
        const data = await loadViz(vizId);

        // Re-upload the CSV to get a fresh csvId
        const blob = new Blob([data.csvContent], { type: "text/csv" });
        const file = new File([blob], data.meta.csvFilename, { type: "text/csv" });
        const formData = new FormData();
        formData.append("csv", file);

        const uploadData = await uploadFile(formData);
        if (!uploadData.csv_id || !uploadData.schema) throw new Error("Failed to re-upload CSV");

        handleUpload(uploadData.csv_id, uploadData.schema);
        dispatch({
          type: "LOAD_VIZ_SUCCESS",
          question: data.meta.question,
          spec: data.spec as unknown as Spec,
          artifacts: data.artifacts ?? null,
        });
      } catch (err) {
        console.error("Load viz failed:", err);
        dispatch({ type: "LOAD_VIZ_ERROR" });
      }
    },
    [handleUpload, dispatch]
  );

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-5xl px-4 py-8">
        <header className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-t-primary">Hermetic</h1>
              <p className="mt-1 text-sm text-t-secondary">
                Upload a CSV or Excel file and ask questions about your data
              </p>
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
              />
              <div
                className="flex items-center gap-1.5 border border-border-default px-2 py-1"
                style={{ borderRadius: "var(--radius-badge)" }}
              >
                <button
                  onClick={() => setSchemaMode("metadata")}
                  className={`px-2 py-0.5 text-xs font-medium transition-colors ${
                    schemaMode === "metadata"
                      ? "bg-accent-subtle text-accent-text"
                      : "text-t-secondary hover:text-t-primary"
                  }`}
                  style={{
                    borderRadius: "var(--radius-badge)",
                    transitionDuration: "var(--transition-speed)",
                  }}
                  title="Send computed column metadata (types, stats, patterns) to the LLM instead of real data"
                >
                  Metadata
                </button>
                <button
                  onClick={() => setSchemaMode("sample")}
                  className={`px-2 py-0.5 text-xs font-medium transition-colors ${
                    schemaMode === "sample"
                      ? "bg-accent-subtle text-accent-text"
                      : "text-t-secondary hover:text-t-primary"
                  }`}
                  style={{
                    borderRadius: "var(--radius-badge)",
                    transitionDuration: "var(--transition-speed)",
                  }}
                  title={`Send ${MAX_SAMPLE_ROWS} sample rows of real data to the LLM`}
                >
                  Sample ({MAX_SAMPLE_ROWS} rows)
                </button>
              </div>
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
          {showSaved && <SavedVizsPanel onLoad={handleLoadViz} refreshKey={savedRefreshKey} />}

          {loadingViz && (
            <div className="flex items-center gap-2 text-sm text-accent">
              Loading saved visualization...
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

              <QueryInput onSubmit={handleQuery} disabled={!isUploaded} isLoading={isAnalyzing} />

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
              />
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}
