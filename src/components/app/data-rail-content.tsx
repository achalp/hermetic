"use client";

import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { CollapsibleSection } from "@/components/app/collapsible-section";
import { SchemaSection } from "@/components/app/data-explorer/schema-section";
import { ProfileSection } from "@/components/app/data-explorer/profile-section";
import { SampleSection } from "@/components/app/data-explorer/sample-section";
import { SheetTabs } from "@/components/app/data-explorer/sheet-tabs";
import { TableList } from "@/components/app/data-explorer/table-list";

interface WarehouseTableSchemaInfo {
  name: string;
  columns: { name: string; type: string; nullable: boolean }[];
  row_count_estimate: number;
  primary_key?: string[];
  foreign_keys?: { column: string; references_table: string; references_column: string }[];
}

interface DataRailContentProps {
  sourceType: "csv" | "excel" | "warehouse";
  sourceName: string;
  schema?: { name: string; type: string; sample: string }[];
  moreColumns?: number;
  profileChips?: string[];
  distributions?: { name: string; percent: number; range: string }[];
  sampleColumns?: string[];
  sampleRows?: string[][];
  sheets?: { name: string; rows: number }[];
  relationships?: { from: string; to: string }[];
  tables?: { name: string; rows: string }[];
  warehouseSchemas?: WarehouseTableSchemaInfo[];
  warehouseId?: string | null;
  fullscreen?: boolean;
  onSheetSelect?: (name: string) => void;
  activeItem?: string;
}

const sourceIcons: Record<DataRailContentProps["sourceType"], string> = {
  csv: "\uD83D\uDCC4",
  excel: "\uD83D\uDCCA",
  warehouse: "\uD83D\uDC18",
};

function normalizeType(t: string): "text" | "number" | "date" {
  const lower = t.toLowerCase();
  if (
    lower.includes("int") ||
    lower.includes("float") ||
    lower.includes("double") ||
    lower.includes("decimal") ||
    lower.includes("numeric") ||
    lower.includes("real") ||
    lower === "number"
  ) {
    return "number";
  }
  if (lower.includes("date") || lower.includes("time") || lower.includes("timestamp")) {
    return "date";
  }
  return "text";
}

export function DataRailContent({
  sourceType,
  sourceName,
  schema,
  moreColumns,
  profileChips,
  distributions,
  sampleColumns,
  sampleRows,
  sheets,
  tables,
  warehouseSchemas,
  warehouseId,
  fullscreen,
  onSheetSelect,
  activeItem,
}: DataRailContentProps) {
  const [activeTable, setActiveTable] = useState<string>(tables?.[0]?.name ?? "");
  const [whSampleData, setWhSampleData] = useState<{ columns: string[]; rows: string[][] } | null>(
    null
  );
  const [sampleFetchKey, setSampleFetchKey] = useState("");

  const selectedTable = sourceType === "warehouse" ? activeTable : undefined;

  // Clear sample data when not in warehouse mode
  const shouldFetchSample = sourceType === "warehouse" && !!warehouseId && !!selectedTable;
  if (!shouldFetchSample && whSampleData !== null) {
    setWhSampleData(null);
  }

  // Fetch sample data when warehouse table selection changes
  const fetchKey = shouldFetchSample ? `${warehouseId}:${selectedTable}` : "";
  useEffect(() => {
    if (!fetchKey) return;
    const controller = new AbortController();
    const [wId, tbl] = fetchKey.split(":");
    fetch(`/api/warehouse/sample?warehouse_id=${wId}&table=${encodeURIComponent(tbl)}`, {
      signal: controller.signal,
    })
      .then((res) => res.json())
      .then((data) => {
        if (!controller.signal.aborted) {
          setWhSampleData({ columns: data.headers ?? [], rows: data.rows ?? [] });
          setSampleFetchKey(fetchKey);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [fetchKey]);

  // Derive schema/profile for the selected warehouse table
  const whTableData = useMemo(() => {
    if (sourceType !== "warehouse" || !warehouseSchemas || !selectedTable) return null;
    const ts = warehouseSchemas.find((t) => t.name === selectedTable);
    if (!ts) return null;

    const cols = ts.columns.slice(0, 8).map((c) => ({
      name: c.name,
      type: normalizeType(c.type),
      sample: c.type,
    }));
    const moreCols = Math.max(0, ts.columns.length - 8);
    const chips = [
      `${ts.row_count_estimate.toLocaleString()} rows`,
      `${ts.columns.length} columns`,
      ...(ts.primary_key?.length ? [`PK: ${ts.primary_key.join(", ")}`] : []),
    ];
    return { cols, moreCols, chips };
  }, [sourceType, warehouseSchemas, selectedTable]);

  const displaySchema = sourceType === "warehouse" ? whTableData?.cols : schema;
  const displayMore = sourceType === "warehouse" ? whTableData?.moreCols : moreColumns;
  const displayChips = sourceType === "warehouse" ? whTableData?.chips : profileChips;
  const displaySampleCols =
    sourceType === "warehouse" ? whSampleData?.columns?.slice(0, 6) : sampleColumns;
  const displaySampleRows =
    sourceType === "warehouse" ? whSampleData?.rows?.slice(0, 5) : sampleRows;

  const isWarehouseWithTables = sourceType === "warehouse" && tables && tables.length > 0;
  const isVerticalSplit = isWarehouseWithTables && fullscreen;
  const isHorizontalSplit = isWarehouseWithTables && !fullscreen;

  // Draggable divider for vertical split (fullscreen mode)
  const [leftWidth, setLeftWidth] = useState(220);
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, width: 0 });

  const onDividerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      dragStart.current = { x: e.clientX, width: leftWidth };
      setIsDragging(true);
      e.preventDefault();
    },
    [leftWidth]
  );

  useEffect(() => {
    if (!isDragging) return;
    const onMove = (e: MouseEvent) => {
      const delta = e.clientX - dragStart.current.x;
      setLeftWidth(Math.max(120, Math.min(500, dragStart.current.width + delta)));
    };
    const onUp = () => setIsDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDragging]);

  const detailContent = (
    <>
      <CollapsibleSection title="SCHEMA" defaultOpen>
        <SchemaSection columns={displaySchema ?? []} moreCount={displayMore} />
      </CollapsibleSection>
      <CollapsibleSection title="PROFILE" defaultOpen>
        <ProfileSection chips={displayChips ?? []} distributions={distributions ?? []} />
      </CollapsibleSection>
      <CollapsibleSection title="SAMPLE" defaultOpen={isWarehouseWithTables}>
        {fetchKey && sampleFetchKey !== fetchKey ? (
          <div style={{ fontSize: 12, color: "var(--color-surface-dark-text4)", padding: "8px 0" }}>
            Loading sample...
          </div>
        ) : (
          <SampleSection columns={displaySampleCols ?? []} rows={displaySampleRows ?? []} />
        )}
      </CollapsibleSection>
    </>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Source name */}
      <div
        style={{
          padding: "12px 20px",
          fontSize: 13,
          color: "var(--color-surface-dark-text2)",
          flexShrink: 0,
        }}
      >
        {sourceIcons[sourceType]} {sourceName}
      </div>

      {sourceType === "excel" && sheets && onSheetSelect && (
        <SheetTabs sheets={sheets} active={activeItem ?? ""} onSelect={onSheetSelect} />
      )}

      {isVerticalSplit ? (
        /* Fullscreen: vertical split with draggable divider */
        <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
          <div style={{ width: leftWidth, flexShrink: 0, overflowY: "auto" }}>
            <TableList tables={tables} active={activeTable} onSelect={setActiveTable} />
          </div>
          {/* Draggable divider */}
          <div
            onMouseDown={onDividerMouseDown}
            style={{
              width: 5,
              flexShrink: 0,
              cursor: "col-resize",
              background: isDragging ? "var(--color-accent)" : "var(--color-surface-dark-2)",
              transition: isDragging ? "none" : "background 0.15s",
            }}
            onMouseEnter={(e) => {
              if (!isDragging) e.currentTarget.style.background = "var(--color-surface-dark-3)";
            }}
            onMouseLeave={(e) => {
              if (!isDragging) e.currentTarget.style.background = "var(--color-surface-dark-2)";
            }}
          />
          <div style={{ flex: 1, overflowY: "auto" }}>{detailContent}</div>
        </div>
      ) : isHorizontalSplit ? (
        /* Narrow (380px): horizontal split — tables on top, detail below */
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
          <div
            style={{
              maxHeight: 160,
              overflowY: "auto",
              flexShrink: 0,
              borderBottom: "1px solid var(--color-surface-dark-2)",
            }}
          >
            <TableList tables={tables} active={activeTable} onSelect={setActiveTable} />
          </div>
          <div style={{ flex: 1, overflowY: "auto" }}>{detailContent}</div>
        </div>
      ) : (
        /* Non-warehouse: single scroll */
        <>{detailContent}</>
      )}
    </div>
  );
}
