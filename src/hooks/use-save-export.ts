"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { Spec } from "@json-render/react";
import {
  downloadDashboardAsPdf,
  downloadDashboardAsDocx,
  downloadDashboardAsPptx,
} from "@/lib/export-utils";
import { saveViz, ApiError } from "@/lib/api";

type ExportFormat = "pdf" | "docx" | "pptx";

interface UseSaveExportOptions {
  csvId: string | null;
  currentSpecRef: MutableRefObject<Spec | null>;
  currentQuestionRef: MutableRefObject<string | null>;
  dashboardRef: MutableRefObject<HTMLDivElement | null>;
  onSaved?: () => void;
}

export function useSaveExport({
  csvId,
  currentSpecRef,
  currentQuestionRef,
  dashboardRef,
  onSaved,
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

  const handleSave = useCallback(async () => {
    if (!csvId || !currentSpecRef.current) return;
    setSaving(true);
    setSaveMessage(null);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    try {
      await saveViz(csvId, currentSpecRef.current, currentQuestionRef.current ?? "Analysis");
      setSaveMessage("Saved!");
      onSaved?.();
      saveTimerRef.current = setTimeout(() => setSaveMessage(null), 2000);
    } catch (err) {
      setSaveMessage(err instanceof ApiError ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [csvId, currentSpecRef, currentQuestionRef, onSaved]);

  const exportWith = useCallback(
    async (format: ExportFormat, fn: (el: HTMLElement, title: string) => Promise<void>) => {
      if (!dashboardRef.current) return;
      setExporting(format);
      try {
        await fn(dashboardRef.current, currentQuestionRef.current ?? "dashboard");
      } catch (e) {
        console.error(`${format.toUpperCase()} export failed:`, e);
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

  return {
    saving,
    saveMessage,
    exporting,
    handleSave,
    handleExportPdf,
    handleExportDocx,
    handleExportPptx,
  };
}
