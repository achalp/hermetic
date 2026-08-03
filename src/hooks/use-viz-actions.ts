"use client";

/**
 * Saved-visualization actions, extracted from page.tsx (ARCH-5): load a saved
 * viz, re-run it against a newly picked file (schema-match fast path vs
 * re-stream), refresh it against the live source, and the auto-save that
 * follows an incompatible re-run. Owns the hidden-file-input refs the re-run
 * flow needs.
 */
import { useCallback, useEffect, useRef } from "react";
import type { Spec } from "@/spec/react";
import type { CSVSchema, SheetInfo, SheetRelationship } from "@/lib/contracts/data-schema";
import type { SandboxRuntimeId } from "@/lib/constants";
import type { PageDispatch } from "@/hooks/use-page-state";
import { loadViz, refreshViz, rerunViz, saveViz } from "@/lib/api";

export function useVizActions(args: {
  dispatch: PageDispatch;
  handleUpload: (csvId: string, schema: CSVSchema) => void;
  loadWorkbookUpload: (
    csvId: string,
    schema: CSVSchema,
    filename: string,
    sheets: SheetInfo[],
    relationships: SheetRelationship[]
  ) => void;
  warehouseId: string | null;
  sandboxRuntime: SandboxRuntimeId;
  loadedVizId: string | null;
  /** Auto-save-after-incompatible-rerun inputs (from page state). */
  isAnalyzing: boolean;
  pendingRerunVizId: string | null;
  csvId: string | null;
  loadedSpec: Spec | null;
  currentQuestion: string | null;
}) {
  const {
    dispatch,
    handleUpload,
    loadWorkbookUpload,
    warehouseId,
    sandboxRuntime,
    loadedVizId,
    isAnalyzing,
    pendingRerunVizId,
    csvId,
    loadedSpec,
    currentQuestion,
  } = args;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const rerunVizIdRef = useRef<string | null>(null);

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
          spec: data.spec,
          artifacts: data.artifacts ?? null,
          vizId,
        });
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
        if (result.schemaMatch && result.spec) {
          handleUpload(result.csvId, result.schema);
          dispatch({
            type: "RERUN_FAST_SUCCESS",
            spec: result.spec,
            artifacts: result.artifacts ?? null,
            vizId,
          });
        } else {
          handleUpload(result.csvId, result.schema);
          // RERUN_STREAM_START sets loadedVizId from its vizId in the reducer.
          dispatch({ type: "RERUN_STREAM_START", question: result.question!, vizId });
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

  const handleRefreshViz = useCallback(
    async (vizId: string) => {
      window.scrollTo({ top: 0, behavior: "smooth" });
      dispatch({ type: "RERUN_START" });
      dispatch({ type: "REFRESH_STAGE", stage: "loading" });
      try {
        // Brief delay so "loading" stage is visible before the fetch begins
        await new Promise((r) => setTimeout(r, 100));
        dispatch({ type: "REFRESH_STAGE", stage: "executing" });
        const result = await refreshViz(vizId, warehouseId, sandboxRuntime);
        dispatch({ type: "REFRESH_STAGE", stage: "composing" });
        handleUpload(result.csvId, result.schema);
        // RERUN_FAST_SUCCESS clears refreshStage in the reducer.
        dispatch({
          type: "RERUN_FAST_SUCCESS",
          spec: result.spec,
          artifacts: result.artifacts ?? null,
          vizId,
        });
      } catch (err) {
        console.error("Refresh failed:", err);
        // RERUN_ERROR clears refreshStage — the stuck-spinner invariant now
        // lives in the reducer, not in per-callsite finally blocks.
        dispatch({ type: "RERUN_ERROR" });
      }
    },
    [dispatch, handleUpload, warehouseId, sandboxRuntime]
  );

  const handleRefreshFromToolbar = useCallback(() => {
    if (loadedVizId) handleRefreshViz(loadedVizId);
  }, [loadedVizId, handleRefreshViz]);

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

  return {
    fileInputRef,
    handleLoadViz,
    handleRerunViz,
    handleRerunFileSelected,
    handleRerunFromToolbar,
    handleRefreshViz,
    handleRefreshFromToolbar,
  };
}
