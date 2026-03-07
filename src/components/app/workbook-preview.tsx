"use client";

import { useState, useMemo } from "react";
import type { SheetInfo, SheetRelationship } from "@/lib/types";
import { SheetTable, RelationshipPanel } from "./sheet-table";
import { useRelationshipAnnotations } from "@/hooks/use-relationship-annotations";

interface WorkbookPreviewProps {
  filename: string;
  sheets: SheetInfo[];
  relationships: SheetRelationship[];
  collapsed?: boolean;
}

export function WorkbookPreview({
  filename,
  sheets,
  relationships,
  collapsed = false,
}: WorkbookPreviewProps) {
  const [open, setOpen] = useState(!collapsed);
  const [activeTab, setActiveTab] = useState(0);
  const [relationshipsExpanded, setRelationshipsExpanded] = useState(false);

  // Sync collapsed prop
  const [prevCollapsed, setPrevCollapsed] = useState(collapsed);
  if (collapsed !== prevCollapsed) {
    setPrevCollapsed(collapsed);
    if (collapsed) setOpen(false);
  }

  const activeSheet = sheets[activeTab];
  const totalRows = useMemo(() => sheets.reduce((sum, s) => sum + s.rowCount, 0), [sheets]);

  const { activeRelationships } = useRelationshipAnnotations(relationships, activeSheet);

  const significantRelationships = useMemo(
    () => relationships.filter((r) => r.confidence >= 0.5),
    [relationships]
  );

  return (
    <div
      className="theme-card border border-border-default bg-surface-1 overflow-hidden"
      style={{
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      {/* Collapsed header */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-6 py-4"
      >
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold text-t-secondary">{filename}</h3>
          <span
            className="inline-flex items-center px-2 py-0.5 text-xs font-medium bg-accent-subtle text-accent-text"
            style={{ borderRadius: "var(--radius-badge)" }}
          >
            Workbook
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-t-tertiary">
            {sheets.length} sheets &middot; {totalRows.toLocaleString()} total rows
            {significantRelationships.length > 0 && (
              <>
                {" "}
                &middot; {significantRelationships.length} relationship
                {significantRelationships.length !== 1 && "s"}
              </>
            )}
          </span>
          <span
            className="text-xs text-t-tertiary transition-transform duration-200"
            style={{ display: "inline-block", transform: open ? "rotate(180deg)" : "rotate(0deg)" }}
          >
            &#9660;
          </span>
        </div>
      </button>

      {open && (
        <>
          {/* All-workbook relationships panel */}
          {significantRelationships.length > 0 && (
            <RelationshipPanel
              relationships={significantRelationships}
              expanded={relationshipsExpanded}
              onExpandedChange={setRelationshipsExpanded}
            />
          )}

          {/* Sheet tabs + table + per-sheet relationships */}
          <div className="border-t border-border-default">
            <SheetTable
              sheets={sheets}
              relationships={relationships}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              showRelationships={false}
            />
          </div>

          {/* Per-sheet relationship summary */}
          {activeRelationships.length > 0 && (
            <div className="px-6 pb-4">
              <p className="text-xs text-t-tertiary">
                This sheet has {activeRelationships.length} relationship
                {activeRelationships.length !== 1 && "s"} with other sheets
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
