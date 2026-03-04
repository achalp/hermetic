"use client";

import { useState, useCallback, useMemo } from "react";
import type { SheetInfo, CSVSchema, SheetRelationship } from "@/lib/types";

interface SheetPickerProps {
  excelId: string;
  filename: string;
  sheets: SheetInfo[];
  relationships: SheetRelationship[];
  onSheetSelected: (csvId: string, schema: CSVSchema) => void;
  onCancel: () => void;
}

const MATCH_TYPE_LABELS: Record<string, string> = {
  exact_name: "exact match",
  fuzzy_name: "similar name",
  value_overlap: "value overlap",
};

export function SheetPicker({
  excelId,
  filename,
  sheets,
  relationships,
  onSheetSelected,
  onCancel,
}: SheetPickerProps) {
  const [activeTab, setActiveTab] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relationshipsExpanded, setRelationshipsExpanded] = useState(false);

  const activeSheet = sheets[activeTab];

  // Pre-computed lookups for relationship annotations
  const relationshipMap = useMemo(() => {
    const map = new Map<string, SheetRelationship[]>();
    for (const rel of relationships) {
      if (rel.confidence < 0.5) continue;
      const srcKey = `${rel.sourceSheet}.${rel.sourceColumn}`;
      const tgtKey = `${rel.targetSheet}.${rel.targetColumn}`;
      if (!map.has(srcKey)) map.set(srcKey, []);
      if (!map.has(tgtKey)) map.set(tgtKey, []);
      map.get(srcKey)!.push(rel);
      map.get(tgtKey)!.push(rel);
    }
    return map;
  }, [relationships]);

  const activeRelationships = useMemo(() => {
    if (!activeSheet) return [];
    return relationships.filter(
      (r) =>
        r.confidence >= 0.5 &&
        (r.sourceSheet === activeSheet.name || r.targetSheet === activeSheet.name)
    );
  }, [relationships, activeSheet]);

  // Sheets that have at least one relationship
  const sheetsWithRelationships = useMemo(() => {
    const names = new Set<string>();
    for (const r of relationships) {
      if (r.confidence >= 0.5) {
        names.add(r.sourceSheet);
        names.add(r.targetSheet);
      }
    }
    return names;
  }, [relationships]);

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

  /** Get badge type for a column header in the active sheet */
  function getColumnBadge(header: string): "pk" | "fk" | "link" | null {
    const key = `${activeSheet.name}.${header}`;
    const rels = relationshipMap.get(key);
    if (!rels || rels.length === 0) return null;

    for (const rel of rels) {
      // Check if this column is the PK side
      if (rel.isPrimaryKeyCandidate) {
        const isPKSide =
          (rel.sourceSheet === activeSheet.name && rel.sourceColumn === header) ||
          (rel.targetSheet === activeSheet.name && rel.targetColumn === header);
        if (isPKSide && rel.isForeignKeyCandidate) {
          // This sheet has the PK, other sheet has the FK
          const isSource = rel.sourceSheet === activeSheet.name && rel.sourceColumn === header;
          if (isSource) return "pk";
          return "fk";
        }
        if (isPKSide) return "pk";
      }
      if (rel.isForeignKeyCandidate) {
        const isFKSide =
          (rel.sourceSheet === activeSheet.name && rel.sourceColumn === header) ||
          (rel.targetSheet === activeSheet.name && rel.targetColumn === header);
        if (isFKSide) return "fk";
      }
    }
    return "link";
  }

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
              {sheetsWithRelationships.has(sheet.name) && (
                <span className="mr-1.5 text-xs opacity-60" aria-label="Has relationships">
                  {"🔗"}
                </span>
              )}
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
                    {activeSheet.headers.map((header, i) => {
                      const badge = getColumnBadge(header);
                      return (
                        <th
                          key={i}
                          className="whitespace-nowrap px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-t-secondary"
                        >
                          <span className="inline-flex items-center gap-1.5">
                            {header}
                            {badge === "pk" && (
                              <span
                                className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-bold leading-none bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                                style={{ borderRadius: "var(--radius-badge)" }}
                                title="Primary key candidate"
                              >
                                PK
                              </span>
                            )}
                            {badge === "fk" && (
                              <span
                                className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-bold leading-none bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
                                style={{ borderRadius: "var(--radius-badge)" }}
                                title="Foreign key candidate"
                              >
                                FK
                              </span>
                            )}
                            {badge === "link" && (
                              <span
                                className="inline-block h-1.5 w-1.5 rounded-full bg-accent"
                                title="Linked to another sheet"
                              />
                            )}
                          </span>
                        </th>
                      );
                    })}
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

      {/* Relationship summary panel — collapsed by default */}
      {activeRelationships.length > 0 && (
        <div
          className="mx-6 mb-4 border border-border-default bg-surface-btn"
          style={{ borderRadius: "var(--radius-card)" }}
        >
          <button
            type="button"
            onClick={() => setRelationshipsExpanded((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-3 text-left"
          >
            <span className="text-xs font-semibold text-t-secondary uppercase tracking-wider">
              Detected relationships ({activeRelationships.length})
            </span>
            <svg
              className={`h-4 w-4 text-t-tertiary transition-transform ${relationshipsExpanded ? "rotate-180" : ""}`}
              style={{ transitionDuration: "var(--transition-speed)" }}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {relationshipsExpanded && (
            <div className="space-y-1 px-4 pb-3">
              {activeRelationships.map((rel, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-t-secondary">
                  <span className="font-medium text-t-primary">{rel.sourceSheet}</span>
                  <span className="text-t-tertiary">.</span>
                  <span>{rel.sourceColumn}</span>
                  <span className="text-t-tertiary mx-1">{"↔"}</span>
                  <span className="font-medium text-t-primary">{rel.targetSheet}</span>
                  <span className="text-t-tertiary">.</span>
                  <span>{rel.targetColumn}</span>
                  <span className="ml-auto text-t-tertiary italic">
                    {MATCH_TYPE_LABELS[rel.matchType] ?? rel.matchType}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

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
