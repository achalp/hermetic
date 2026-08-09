"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Spec } from "@/spec/react";
import {
  downloadDashboardAsPdf,
  downloadDashboardAsDocx,
  downloadDashboardAsPptx,
  triggerDownload,
} from "@/lib/export-utils";
import { saveViz, exportInteractiveHtml, ApiError } from "@/app/lib/api";

type ExportFormat = "pdf" | "docx" | "pptx" | "html";

/** Human size for the export status line ("3.2 MB", "412 KB"). */
function formatBytes(bytes: number): string {
  const MB = 1024 * 1024;
  return bytes >= MB
    ? `${(bytes / MB).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

interface UseSaveExportOptions {
  csvId: string | null;
  currentSpecRef: MutableRefObject<Spec | null>;
  currentQuestionRef: MutableRefObject<string | null>;
  dashboardRef: MutableRefObject<HTMLDivElement | null>;
  onSaved?: () => void;
  /** History-entry id of the displayed analysis — persisted into the saved
   *  viz's meta so a restored viz keeps its audit key (separate namespaces:
   *  a vizId can never stand in for a history id). */
  historyId?: string | null;
}

export function useSaveExport({
  csvId,
  currentSpecRef,
  currentQuestionRef,
  dashboardRef,
  onSaved,
  historyId,
}: UseSaveExportOptions) {
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, []);

  const [lastSavedVizId, setLastSavedVizId] = useState<string | null>(null);

  /**
   * Save the current viz. Returns the saved viz's id (or null if save failed
   * or there's nothing to save). The caller can use the returned id directly
   * — useful for "save then schedule" flows where the schedule needs the
   * vizId immediately, before the parent's onSaved → state-roundtrip.
   */
  const handleSave = useCallback(async (): Promise<string | null> => {
    if (!csvId || !currentSpecRef.current) return null;
    setSaving(true);
    setSaveMessage(null);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    try {
      const result = await saveViz(
        csvId,
        currentSpecRef.current,
        currentQuestionRef.current ?? "Analysis",
        undefined,
        historyId
      );
      setSaveMessage("Saved!");
      setLastSavedVizId(result.meta.vizId);
      onSaved?.();
      saveTimerRef.current = setTimeout(() => setSaveMessage(null), 2000);
      return result.meta.vizId;
    } catch (err) {
      setSaveMessage(err instanceof ApiError ? err.message : "Save failed");
      return null;
    } finally {
      setSaving(false);
    }
  }, [csvId, currentSpecRef, currentQuestionRef, onSaved, historyId]);

  const exportWith = useCallback(
    async (format: ExportFormat, fn: (el: HTMLElement, title: string) => Promise<void>) => {
      if (!dashboardRef.current) return;
      setExporting(format);
      setSaveMessage(null);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      try {
        await fn(dashboardRef.current, currentQuestionRef.current ?? "dashboard");
      } catch (e) {
        // Surface the failure through the same status channel as Save —
        // previously this was console.error only, so a failed toolbar export
        // gave the user no feedback at all (spinner stops, no file, silence).
        console.error(`${format.toUpperCase()} export failed:`, e);
        setSaveMessage(`${format.toUpperCase()} export failed`);
        saveTimerRef.current = setTimeout(() => setSaveMessage(null), 4000);
      } finally {
        setExporting(null);
      }
    },
    [dashboardRef, currentQuestionRef]
  );

  const handleExportPdf = useCallback(
    () => exportWith("pdf", downloadDashboardAsPdf),
    [exportWith]
  );
  const handleExportDocx = useCallback(
    () => exportWith("docx", downloadDashboardAsDocx),
    [exportWith]
  );
  const handleExportPptx = useCallback(
    () => exportWith("pptx", downloadDashboardAsPptx),
    [exportWith]
  );

  /**
   * Single-file interactive HTML export (dashboard-distribution spec §4.2).
   * Unlike the DOM-capture formats above, this compiles the SPEC server-side
   * — so it takes currentSpecRef, not dashboardRef, and doesn't fit
   * exportWith's (el, title) shape. The live spec goes as-is: `__`-prefixed
   * internal state is stripped by the assembler, not the client.
   */
  const handleExportHtml = useCallback(async () => {
    const spec = currentSpecRef.current;
    if (!spec) return;
    setExporting("html");
    setSaveMessage(null);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    try {
      const result = await exportInteractiveHtml(spec, currentQuestionRef.current);
      const url = URL.createObjectURL(result.blob);
      triggerDownload(url, result.filename);
      URL.revokeObjectURL(url);
      // Size honesty (spec §5): say which bundle got inlined and how big the
      // file is, through the same status channel Save uses.
      setSaveMessage(`HTML: ${result.bundle} bundle, ${formatBytes(result.bytes)}`);
      saveTimerRef.current = setTimeout(() => setSaveMessage(null), 4000);
    } catch (e) {
      console.error("HTML export failed:", e);
      setSaveMessage(e instanceof ApiError ? e.message : "HTML export failed");
      saveTimerRef.current = setTimeout(() => setSaveMessage(null), 4000);
    } finally {
      setExporting(null);
    }
  }, [currentSpecRef, currentQuestionRef]);

  return {
    saving,
    saveMessage,
    exporting,
    handleSave,
    handleExportPdf,
    handleExportDocx,
    handleExportPptx,
    handleExportHtml,
    lastSavedVizId,
  };
}
