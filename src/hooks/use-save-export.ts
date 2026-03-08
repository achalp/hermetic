"use client";

import { useCallback, useState, type MutableRefObject } from "react";
import type { Spec } from "@json-render/react";
import {
  downloadDashboardAsPdf,
  downloadDashboardAsDocx,
  downloadDashboardAsPptx,
} from "@/lib/export-utils";

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

  const handleSave = useCallback(async () => {
    if (!csvId || !currentSpecRef.current) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const res = await fetch("/api/vizs/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          csvId,
          spec: currentSpecRef.current,
          question: currentQuestionRef.current ?? "Analysis",
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setSaveMessage(data.error ?? "Save failed");
      } else {
        setSaveMessage("Saved!");
        onSaved?.();
        setTimeout(() => setSaveMessage(null), 2000);
      }
    } catch {
      setSaveMessage("Save failed");
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
