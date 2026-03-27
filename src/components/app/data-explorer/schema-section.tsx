"use client";

import { useState } from "react";

interface SchemaSectionProps {
  columns: { name: string; type: string; sample: string }[];
  moreCount?: number;
  allColumns?: { name: string; type: string; sample: string }[];
}

const typeBadgeStyles: Record<string, { background: string; color: string }> = {
  text: { background: "rgba(148,163,184,0.2)", color: "var(--color-surface-dark-text3)" },
  number: { background: "rgba(96,165,250,0.2)", color: "#60a5fa" },
  date: { background: "rgba(251,191,36,0.2)", color: "#fbbf24" },
};

export function SchemaSection({ columns, moreCount, allColumns }: SchemaSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded && allColumns ? allColumns : columns;
  const canExpand = (moreCount ?? 0) > 0 && allColumns && allColumns.length > columns.length;

  return (
    <div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["Column", "Type", "Sample"].map((h) => (
              <th
                key={h}
                style={{
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "var(--color-surface-dark-text4)",
                  padding: "6px 0",
                  textAlign: "left",
                  fontWeight: 500,
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible.map((col) => {
            const badge = typeBadgeStyles[col.type] ?? typeBadgeStyles.text;
            return (
              <tr key={col.name} style={{ borderBottom: "1px solid var(--color-surface-dark-2)" }}>
                <td
                  style={{
                    fontSize: 13,
                    color: "var(--color-surface-dark-text2)",
                    padding: "6px 0",
                  }}
                >
                  {col.name}
                </td>
                <td style={{ padding: "6px 0" }}>
                  <span
                    style={{
                      fontSize: 11,
                      padding: "2px 6px",
                      borderRadius: 3,
                      background: badge.background,
                      color: badge.color,
                    }}
                  >
                    {col.type}
                  </span>
                </td>
                <td
                  style={{
                    fontSize: 13,
                    color: "var(--color-surface-dark-text2)",
                    padding: "6px 0",
                  }}
                >
                  {col.sample}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {canExpand && (
        <button
          onClick={() => setExpanded((v) => !v)}
          style={{
            fontSize: 12,
            color: "var(--color-accent)",
            marginTop: 4,
            background: "none",
            border: "none",
            cursor: "pointer",
            fontFamily: "inherit",
            padding: 0,
          }}
        >
          {expanded ? "Show less" : `+${moreCount} more`}
        </button>
      )}
    </div>
  );
}
