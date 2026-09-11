"use client";

/**
 * Actions on the current analysis (extracted from page.tsx, exit audit F1):
 * the LLM-readiness-guarded query, style re-ask, save/export, the schedule
 * popover, and the dashboard Slides export. One hook because they share the
 * same inputs — the current question/spec refs and the save pipeline.
 */
import { useCallback, type RefObject } from "react";
import type { QueryMode } from "@/app/components/query-input";
import { useSaveExport } from "@/hooks/use-save-export";
import { useSchedulePopover } from "@/hooks/use-schedule-popover";
import type { useCurrentAnalysis } from "@/hooks/use-current-analysis";
import { checkLlmReady } from "@/app/lib/api";

interface UseAnalysisActionsArgs {
  csvId: string | null;
  analysis: ReturnType<typeof useCurrentAnalysis>;
  dashboardRef: RefObject<HTMLDivElement | null>;
  onSaved: () => void;
  handleQuery: (question: string, mode: QueryMode) => void;
  /**
   * Manifest selection pre-step (spec §7) — runs BEFORE dispatch for BOTH
   * modes; this shared gate is what keeps ask and investigate at par on the
   * client. Optional: absent when no manifest source is connected.
   */
  prepareManifestForQuestion?: (question: string) => Promise<void>;
  /** Flip to the progress view before the (possibly slow) pre-step runs. */
  beginPreparing?: (question: string, mode: QueryMode) => void;
  queryMode: QueryMode;
  currentQuestion: string | null;
  currentMode: QueryMode;
  isAnalyzing: boolean;
  loadedVizId: string | null;
  /** History-entry id of the displayed analysis (the audit key) — persisted
   *  into the viz meta on save so restores keep their audit. */
  historyId?: string | null;
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
  prepareManifestForQuestion,
  beginPreparing,
  queryMode,
  currentQuestion,
  currentMode,
  isAnalyzing,
  loadedVizId,
  historyId,
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
    historyId,
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
      const effectiveMode = mode ?? queryMode;
      // Flip to the progress view BEFORE the manifest pre-step: entity
      // selection + on-demand schema extraction can take minutes on a cold
      // desktop-wasm install, and awaiting it first left the question page
      // frozen while the server logged steady progress (found on the first
      // real mac manifest question, v0.5.6). PREPARING shows the
      // interstitial without starting the stream.
      beginPreparing?.(question, effectiveMode);
      // Manifest sources: select entities + ensure them BEFORE the stream
      // dispatch, so the request carries the multi-entity context (a failed
      // pre-step degrades to the single active entity, never blocks the ask).
      await prepareManifestForQuestion?.(question);
      handleQuery(question, effectiveMode);
    },
    [
      handleQuery,
      beginPreparing,
      openSettings,
      queryMode,
      setLlmWarning,
      prepareManifestForQuestion,
    ]
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
