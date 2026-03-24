"use client";

import { CollapsibleSection } from "@/components/app/collapsible-section";
import { SchemaSection } from "@/components/app/data-explorer/schema-section";
import { ProfileSection } from "@/components/app/data-explorer/profile-section";
import { SampleSection } from "@/components/app/data-explorer/sample-section";
import { SheetTabs } from "@/components/app/data-explorer/sheet-tabs";
import { TableList } from "@/components/app/data-explorer/table-list";

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
  onSheetSelect?: (name: string) => void;
  onTableSelect?: (name: string) => void;
  activeItem?: string;
}

const sourceIcons: Record<DataRailContentProps["sourceType"], string> = {
  csv: "\uD83D\uDCC4",
  excel: "\uD83D\uDCCA",
  warehouse: "\uD83D\uDC18",
};

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
  onSheetSelect,
  onTableSelect,
  activeItem,
}: DataRailContentProps) {
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

      {sourceType === "warehouse" && tables && onTableSelect && (
        <TableList tables={tables} active={activeItem ?? ""} onSelect={onTableSelect} />
      )}

      <CollapsibleSection title="SCHEMA" defaultOpen>
        <SchemaSection columns={schema ?? []} moreCount={moreColumns} />
      </CollapsibleSection>

      <CollapsibleSection title="PROFILE" defaultOpen>
        <ProfileSection chips={profileChips ?? []} distributions={distributions ?? []} />
      </CollapsibleSection>

      <CollapsibleSection title="SAMPLE" defaultOpen={false}>
        <SampleSection columns={sampleColumns ?? []} rows={sampleRows ?? []} />
      </CollapsibleSection>
    </div>
  );
}
