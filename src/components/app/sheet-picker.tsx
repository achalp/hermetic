"use client";

import { useState, useCallback } from "react";
import type { SheetInfo, CSVSchema } from "@/lib/types";

interface SheetPickerProps {
  excelId: string;
  filename: string;
  sheets: SheetInfo[];
  onSheetSelected: (csvId: string, schema: CSVSchema) => void;
  onCancel: () => void;
}

export function SheetPicker({
  excelId,
  filename,
  sheets,
  onSheetSelected,
  onCancel,
}: SheetPickerProps) {
  const [activeTab, setActiveTab] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

      {/* Tab bar */}
      <div className="border-b border-border-default">
        <div className="flex overflow-x-auto px-6" role="tablist">
          {sheets.map((sheet, idx) => (
            <button
              key={sheet.name}
              role="tab"
              aria-selected={activeTab === idx}
              onClick={() => setActiveTab(idx)}
              className={`shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                activeTab === idx
                  ? "border-accent text-accent"
                  : "border-transparent text-t-secondary hover:border-border-default hover:text-t-primary"
              }`}
              style={{ transitionDuration: "var(--transition-speed)" }}
            >
              {sheet.name}
              <span
                className={`ml-2 inline-flex items-center px-2 py-0.5 text-xs font-medium ${
                  activeTab === idx
                    ? "bg-accent-subtle text-accent-text"
                    : "bg-surface-btn text-t-secondary"
                }`}
                style={{ borderRadius: "var(--radius-badge)" }}
              >
                {activeSheet && sheet.name === activeSheet.name
                  ? activeSheet.rowCount
                  : sheet.rowCount}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Preview table */}
      <div className="px-6 py-4">
        {activeSheet.headers && activeSheet.headers.length > 0 ? (
          <>
            <div
              className="overflow-x-auto border border-border-default"
              style={{ borderRadius: "var(--radius-badge)" }}
            >
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="bg-table-header-bg">
                    {activeSheet.headers.map((header, i) => (
                      <th
                        key={i}
                        className="whitespace-nowrap px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-t-secondary"
                      >
                        {header}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-table-divider">
                  {activeSheet.sampleRows?.map((row, rIdx) => (
                    <tr
                      key={rIdx}
                      className="hover:bg-table-row-hover transition-colors"
                      style={{ transitionDuration: "var(--transition-speed)" }}
                    >
                      {row.map((cell, cIdx) => (
                        <td key={cIdx} className="whitespace-nowrap px-4 py-2 text-t-secondary">
                          {cell || <span className="text-t-tertiary">&mdash;</span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-t-tertiary">
              Showing {activeSheet.sampleRows?.length ?? 0} of {activeSheet.rowCount} rows
              {" \u00B7 "}
              {activeSheet.columnCount} columns
            </p>
          </>
        ) : (
          <p className="py-8 text-center text-sm text-t-tertiary">
            No preview available &mdash; {activeSheet.rowCount} rows, {activeSheet.columnCount}{" "}
            columns
          </p>
        )}
      </div>

      {/* Actions */}
      {error && (
        <div className="px-6">
          <p className="text-sm text-error-text">{error}</p>
        </div>
      )}

      <div className="flex gap-3 border-t border-border-default px-6 py-4">
        <button
          onClick={handleConfirm}
          disabled={isLoading}
          className="bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
          style={{
            borderRadius: "var(--radius-button)",
            transitionDuration: "var(--transition-speed)",
          }}
        >
          {isLoading ? "Converting..." : `Use "${activeSheet.name}"`}
        </button>
        <button
          onClick={onCancel}
          disabled={isLoading}
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
