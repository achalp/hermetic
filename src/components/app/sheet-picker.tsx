"use client";

import { useState, useCallback } from "react";
import type { SheetInfo, CSVSchema, SheetRelationship } from "@/lib/types";
import { SheetTable } from "./sheet-table";

interface SheetPickerProps {
  excelId: string;
  filename: string;
  sheets: SheetInfo[];
  relationships: SheetRelationship[];
  onSheetSelected: (csvId: string, schema: CSVSchema) => void;
  onWorkbookSelected: (csvId: string, schema: CSVSchema) => void;
  onCancel: () => void;
}

export function SheetPicker({
  excelId,
  filename,
  sheets,
  relationships,
  onSheetSelected,
  onWorkbookSelected,
  onCancel,
}: SheetPickerProps) {
  const [activeTab, setActiveTab] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingWorkbook, setLoadingWorkbook] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relationshipsExpanded, setRelationshipsExpanded] = useState(false);

  const showWorkbookButton = relationships.length > 0 || sheets.length >= 2;
  const activeSheet = sheets[activeTab];

  const handleConfirm = useCallback(async () => {
    setError(null);
    setIsLoading(true);

    try {
      const res = await fetch("/api/upload/select-sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excel_id: excelId, sheet_name: activeSheet.name }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "Sheet selection failed");
      }

      onSheetSelected(data.csv_id, data.schema);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sheet selection failed");
    } finally {
      setIsLoading(false);
    }
  }, [excelId, activeSheet.name, onSheetSelected]);

  const handleWorkbookConfirm = useCallback(async () => {
    setError(null);
    setLoadingWorkbook(true);

    try {
      const res = await fetch("/api/upload/select-workbook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ excel_id: excelId }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "Workbook selection failed");
      }

      onWorkbookSelected(data.csv_id, data.schema);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Workbook selection failed");
    } finally {
      setLoadingWorkbook(false);
    }
  }, [excelId, onWorkbookSelected]);

  return (
    <div
      className="theme-card border border-border-default bg-surface-1 overflow-hidden"
      style={{
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      {/* Header */}
      <div className="px-6 pt-6 pb-4">
        <h3 className="text-lg font-semibold text-t-primary">Select a sheet</h3>
        <p className="mt-1 text-sm text-t-secondary">
          {filename} has {sheets.length} sheets. Preview data and choose which one to analyze.
        </p>
      </div>

      <SheetTable
        sheets={sheets}
        relationships={relationships}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        showRelationships={true}
        relationshipsExpanded={relationshipsExpanded}
        onRelationshipsExpandedChange={setRelationshipsExpanded}
      />

      {/* Actions */}
      {error && (
        <div className="px-6">
          <p className="text-sm text-error-text">{error}</p>
        </div>
      )}

      <div className="flex gap-3 border-t border-border-default px-6 py-4">
        <button
          onClick={handleConfirm}
          disabled={isLoading || loadingWorkbook}
          className="bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          style={{
            borderRadius: "var(--radius-button)",
            transitionDuration: "var(--transition-speed)",
          }}
        >
          {isLoading ? "Converting..." : `Use "${activeSheet.name}"`}
        </button>
        {showWorkbookButton && (
          <button
            onClick={handleWorkbookConfirm}
            disabled={isLoading || loadingWorkbook}
            className="border border-accent bg-accent-subtle px-4 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent hover:text-white disabled:opacity-50"
            style={{
              borderRadius: "var(--radius-button)",
              transitionDuration: "var(--transition-speed)",
            }}
          >
            {loadingWorkbook ? "Processing..." : `Use entire workbook`}
            {!loadingWorkbook && (
              <span className="ml-1.5 text-xs opacity-75">({sheets.length} sheets)</span>
            )}
          </button>
        )}
        <button
          onClick={onCancel}
          disabled={isLoading || loadingWorkbook}
          className="border border-border-default bg-surface-1 px-4 py-2 text-sm font-medium text-t-secondary transition-colors hover:bg-surface-btn disabled:opacity-50"
          style={{
            borderRadius: "var(--radius-button)",
            transitionDuration: "var(--transition-speed)",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
