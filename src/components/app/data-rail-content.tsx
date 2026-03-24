"use client";

import { useState, useMemo } from "react";
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
  /** Full warehouse table schemas for deriving per-table detail */
  warehouseSchemas?: WarehouseTableSchemaInfo[];
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
  onSheetSelect,
  activeItem,
}: DataRailContentProps) {
  // Internal state for warehouse table selection
  const [activeTable, setActiveTable] = useState<string>(tables?.[0]?.name ?? "");

  const selectedTable = sourceType === "warehouse" ? activeTable : undefined;

  // Derive schema/profile for the selected warehouse table
  const whTableData = useMemo(() => {
    if (sourceType !== "warehouse" || !warehouseSchemas || !selectedTable) {
      return null;
    }
    const ts = warehouseSchemas.find((t) => t.name === selectedTable);
    if (!ts) return null;

    const cols = ts.columns.slice(0, 8).map((c) => ({
      name: c.name,
      type: normalizeType(c.type),
      sample: c.type, // show the raw type as "sample" since we don't have actual values
    }));
    const moreCols = Math.max(0, ts.columns.length - 8);
    const chips = [
      `${ts.row_count_estimate.toLocaleString()} rows`,
      `${ts.columns.length} columns`,
      ...(ts.primary_key?.length ? [`PK: ${ts.primary_key.join(", ")}`] : []),
    ];
    const fkRelationships = ts.foreign_keys?.map((fk) => ({
      from: `${ts.name}.${fk.column}`,
      to: `${fk.references_table}.${fk.references_column}`,
    }));

    return { cols, moreCols, chips, fkRelationships };
  }, [sourceType, warehouseSchemas, selectedTable]);

  // Choose what to show based on source type
  const displaySchema = sourceType === "warehouse" ? whTableData?.cols : schema;
  const displayMore = sourceType === "warehouse" ? whTableData?.moreCols : moreColumns;
  const displayChips = sourceType === "warehouse" ? whTableData?.chips : profileChips;
  const displaySampleCols =
    sourceType === "warehouse" ? whTableData?.cols?.slice(0, 5).map((c) => c.name) : sampleColumns;
  const displaySampleRows = sourceType === "warehouse" ? [] : sampleRows;

  return (
    <div>
      <div
        style={{
          padding: "12px 20px",
          fontSize: 13,
          color: "var(--color-surface-dark-text2)",
        }}
      >
        {sourceIcons[sourceType]} {sourceName}
      </div>

      {sourceType === "excel" && sheets && onSheetSelect && (
        <SheetTabs sheets={sheets} active={activeItem ?? ""} onSelect={onSheetSelect} />
      )}

      {sourceType === "warehouse" && tables && (
        <TableList tables={tables} active={activeTable} onSelect={(name) => setActiveTable(name)} />
      )}

      <CollapsibleSection title="SCHEMA" defaultOpen>
        <SchemaSection columns={displaySchema ?? []} moreCount={displayMore} />
      </CollapsibleSection>

      <CollapsibleSection title="PROFILE" defaultOpen>
        <ProfileSection chips={displayChips ?? []} distributions={distributions ?? []} />
      </CollapsibleSection>

      <CollapsibleSection title="SAMPLE" defaultOpen={false}>
        <SampleSection columns={displaySampleCols ?? []} rows={displaySampleRows ?? []} />
      </CollapsibleSection>
    </div>
  );
}
