"use client";

import { useState, useEffect } from "react";
import type { CSVSchema } from "@/lib/types";

interface SchemaPreviewProps {
  schema: CSVSchema;
  collapsed?: boolean;
}

export function SchemaPreview({ schema, collapsed = false }: SchemaPreviewProps) {
  const columnNames = schema.columns.map((c) => c.name);
  const [open, setOpen] = useState(!collapsed);

  // Collapse when parent signals (e.g. new query submitted)
  useEffect(() => {
    if (collapsed) setOpen(false);
  }, [collapsed]);

  return (
    <div
      className="theme-card border border-border-default bg-surface-1 p-4"
      style={{
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between"
      >
        <h3 className="text-sm font-semibold text-t-secondary">
          {schema.filename}
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-t-tertiary">
            {schema.row_count.toLocaleString()} rows &middot;{" "}
            {schema.columns.length} columns
          </span>
          <span className="text-xs text-t-tertiary transition-transform duration-200" style={{ display: "inline-block", transform: open ? "rotate(180deg)" : "rotate(0deg)" }}>
            &#9660;
          </span>
        </div>
      </button>

      {open && schema.sample_rows.length > 0 && (
        <div
          className="mt-3 overflow-x-auto border border-border-default"
          style={{ borderRadius: "var(--radius-badge)" }}
        >
          <table className="min-w-full text-left text-xs">
            <thead>
              <tr className="border-b border-table-divider bg-table-header-bg">
                <th className="px-3 py-2 font-medium text-t-tertiary">
                  #
                </th>
                {columnNames.map((name) => (
                  <th
                    key={name}
                    className="whitespace-nowrap px-3 py-2 font-medium text-t-secondary"
                  >
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {schema.sample_rows.map((row, i) => (
                <tr
                  key={i}
                  className={
                    i % 2 === 0
                      ? "bg-surface-1"
                      : "bg-surface-2"
                  }
                >
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
    </div>
  );
}
