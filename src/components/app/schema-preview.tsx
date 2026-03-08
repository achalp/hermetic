"use client";

import type { CSVSchema } from "@/lib/types";
import { CollapsibleSection } from "@/components/ui/collapsible-section";

interface SchemaPreviewProps {
  schema: CSVSchema;
  collapsed?: boolean;
}

export function SchemaPreview({ schema, collapsed = false }: SchemaPreviewProps) {
  const columnNames = schema.columns.map((c) => c.name);

  return (
    <CollapsibleSection
      title={schema.filename}
      meta={`${schema.row_count.toLocaleString()} rows \u00B7 ${schema.columns.length} columns`}
      collapsed={collapsed}
    >
      {schema.sample_rows.length > 0 && (
        <div
          className="overflow-x-auto border border-border-default"
          style={{ borderRadius: "var(--radius-badge)" }}
        >
          <table className="min-w-full text-left text-xs">
            <thead>
              <tr className="border-b border-table-divider bg-table-header-bg">
                <th scope="col" className="px-3 py-2 font-medium text-t-tertiary">
                  #
                </th>
                {columnNames.map((name) => (
                  <th
                    key={name}
                    scope="col"
                    className="whitespace-nowrap px-3 py-2 font-medium text-t-secondary"
                  >
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {schema.sample_rows.map((row, i) => (
                <tr key={i} className={i % 2 === 0 ? "bg-surface-1" : "bg-surface-2"}>
                  <td className="px-3 py-1.5 text-t-tertiary">{i + 1}</td>
                  {columnNames.map((name) => (
                    <td
                      key={name}
                      className="max-w-[200px] truncate whitespace-nowrap px-3 py-1.5 text-t-secondary"
                      title={row[name] ?? ""}
                    >
                      {row[name] ?? ""}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </CollapsibleSection>
  );
}
