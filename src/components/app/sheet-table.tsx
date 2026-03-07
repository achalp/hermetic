"use client";

import type { SheetInfo, SheetRelationship } from "@/lib/types";
import {
  useRelationshipAnnotations,
  MATCH_TYPE_LABELS,
} from "@/hooks/use-relationship-annotations";

interface SheetTableProps {
  sheets: SheetInfo[];
  relationships: SheetRelationship[];
  activeTab: number;
  onTabChange: (index: number) => void;
  /** Optional: show the relationship summary panel below the table */
  showRelationships?: boolean;
  /** If provided, controls relationship panel expansion externally */
  relationshipsExpanded?: boolean;
  onRelationshipsExpandedChange?: (expanded: boolean) => void;
}

export function SheetTable({
  sheets,
  relationships,
  activeTab,
  onTabChange,
  showRelationships = true,
  relationshipsExpanded = false,
  onRelationshipsExpandedChange,
}: SheetTableProps) {
  const activeSheet = sheets[activeTab];
  const { activeRelationships, sheetsWithRelationships, getColumnBadge } =
    useRelationshipAnnotations(relationships, activeSheet);

  return (
    <>
      {/* Tab bar */}
      <div className="border-b border-border-default">
        <div className="flex overflow-x-auto px-6" role="tablist">
          {sheets.map((sheet, idx) => (
            <button
              key={sheet.name}
              role="tab"
              aria-selected={activeTab === idx}
              onClick={() => onTabChange(idx)}
              className={`shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                activeTab === idx
                  ? "border-accent text-accent"
                  : "border-transparent text-t-secondary hover:border-border-default hover:text-t-primary"
              }`}
              style={{ transitionDuration: "var(--transition-speed)" }}
            >
              {sheetsWithRelationships.has(sheet.name) && (
                <span className="mr-1.5 text-xs opacity-60" aria-label="Has relationships">
                  {"\uD83D\uDD17"}
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
                {sheet.rowCount}
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

      {/* Relationship summary panel */}
      {showRelationships && activeRelationships.length > 0 && (
        <RelationshipPanel
          relationships={activeRelationships}
          expanded={relationshipsExpanded}
          onExpandedChange={onRelationshipsExpandedChange}
        />
      )}
    </>
  );
}

interface RelationshipPanelProps {
  relationships: SheetRelationship[];
  expanded: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

export function RelationshipPanel({
  relationships,
  expanded,
  onExpandedChange,
}: RelationshipPanelProps) {
  return (
    <div
      className="mx-6 mb-4 border border-border-default bg-surface-btn"
      style={{ borderRadius: "var(--radius-card)" }}
    >
      <button
        type="button"
        onClick={() => onExpandedChange?.(!expanded)}
        className="flex w-full items-center justify-between px-4 py-3 text-left"
      >
        <span className="text-xs font-semibold text-t-secondary uppercase tracking-wider">
          Detected relationships ({relationships.length})
        </span>
        <svg
          className={`h-4 w-4 text-t-tertiary transition-transform ${expanded ? "rotate-180" : ""}`}
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
      {expanded && (
        <div className="space-y-1 px-4 pb-3">
          {relationships.map((rel, i) => (
            <div key={i} className="flex items-center gap-2 text-xs text-t-secondary">
              <span className="font-medium text-t-primary">{rel.sourceSheet}</span>
              <span className="text-t-tertiary">.</span>
              <span>{rel.sourceColumn}</span>
              {rel.isPrimaryKeyCandidate && (
                <span
                  className="inline-flex items-center px-1 py-0.5 text-[9px] font-bold leading-none bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                  style={{ borderRadius: "var(--radius-badge)" }}
                >
                  PK
                </span>
              )}
              <span className="text-t-tertiary mx-1">{"\u2194"}</span>
              <span className="font-medium text-t-primary">{rel.targetSheet}</span>
              <span className="text-t-tertiary">.</span>
              <span>{rel.targetColumn}</span>
              {rel.isForeignKeyCandidate && (
                <span
                  className="inline-flex items-center px-1 py-0.5 text-[9px] font-bold leading-none bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
                  style={{ borderRadius: "var(--radius-badge)" }}
                >
                  FK
                </span>
              )}
              <span className="ml-auto text-t-tertiary italic">
                {MATCH_TYPE_LABELS[rel.matchType] ?? rel.matchType}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
