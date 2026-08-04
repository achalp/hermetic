"use client";

/**
 * Actions on the current analysis (extracted from page.tsx, exit audit F1):
 * the LLM-readiness-guarded query, style re-ask, save/export, the schedule
 * popover, and the dashboard Slides export. One hook because they share the
 * same inputs — the current question/spec refs and the save pipeline.
 */
import { useCallback, type RefObject } from "react";
import type { QueryMode } from "@/components/app/query-input";
import { useSaveExport } from "@/hooks/use-save-export";
import { useSchedulePopover } from "@/hooks/use-schedule-popover";
import type { useCurrentAnalysis } from "@/hooks/use-current-analysis";
import { checkLlmReady } from "@/lib/api";

interface UseAnalysisActionsArgs {
  csvId: string | null;
  analysis: ReturnType<typeof useCurrentAnalysis>;
  dashboardRef: RefObject<HTMLDivElement | null>;
  onSaved: () => void;
  handleQuery: (question: string, mode: QueryMode) => void;
  queryMode: QueryMode;
  currentQuestion: string | null;
  currentMode: QueryMode;
  isAnalyzing: boolean;
  loadedVizId: string | null;
  setPurpose: (id: string) => void;
  setLlmWarning: (w: string | null) => void;
  openSettings: () => void;
}

export function useAnalysisActions({
  csvId,
  analysis,
  dashboardRef,
  onSaved,
  handleQuery,
  queryMode,
  currentQuestion,
  currentMode,
  isAnalyzing,
  loadedVizId,
  setPurpose,
  setLlmWarning,
  openSettings,
}: UseAnalysisActionsArgs) {
  const saveExport = useSaveExport({
    // effectiveCsvId first (M5-5e): a warehouse analysis materializes its
    // data under a NEW csvId reported mid-stream — saving under the raw
    // upload id (null for warehouse runs) was the audit's save-vs-artifacts
    // id divergence.
    csvId,
    currentSpecRef: analysis.specRef,
    currentQuestionRef: analysis.questionRef,
    dashboardRef,
    onSaved,
  });

  // Schedule popover state + auto-save-then-open — use-schedule-popover.
  const schedule = useSchedulePopover({
    loadedVizId,
    lastSavedVizId: saveExport.lastSavedVizId,
    doSave: saveExport.handleSave,
  });

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
    [handleQuery, openSettings, queryMode, setLlmWarning]
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
    [currentQuestion, isAnalyzing, currentMode, handleGuardedQuery, setPurpose]
  );

  // Dashboard "Slides" export — segment the rendered dashboard into a Reveal
  // deck. (Notebook view registers its own slides handler via the export API.)
  const handleExportSlides = useCallback(async () => {
    const root = dashboardRef.current;
    if (!root) return;
    const { downloadAsSlides } = await import("@/lib/slides-export");
    await downloadAsSlides(root, analysis.questionRef.current ?? "dashboard");
  }, [analysis.questionRef, dashboardRef]);

  return { saveExport, schedule, handleGuardedQuery, handleStyleChange, handleExportSlides };
}
