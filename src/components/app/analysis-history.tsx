"use client";

import { useState } from "react";
import type { Spec } from "@json-render/react";

interface HistoryEntry {
  question: string;
  spec: Spec;
  timestamp: number;
}

interface AnalysisHistoryProps {
  entries: HistoryEntry[];
  onReplay: (question: string) => void;
}

export type { HistoryEntry };

export function AnalysisHistory({ entries, onReplay }: AnalysisHistoryProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  if (entries.length === 0) return null;

  return (
    <div className="mb-6">
      <div
        style={{
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--color-t-tertiary)",
          marginBottom: 8,
        }}
      >
        Previous analyses ({entries.length})
      </div>
      <div className="flex flex-col gap-2">
        {entries.map((entry, i) => (
          <div
            key={entry.timestamp}
            style={{
              border: "1px solid var(--color-border-default)",
              borderRadius: "var(--radius-card)",
              background: "var(--color-surface-1)",
              overflow: "hidden",
            }}
          >
            <button
              onClick={() => setExpandedIndex(expandedIndex === i ? null : i)}
              className="flex w-full items-center justify-between text-left transition-colors"
              style={{
                padding: "10px 14px",
                fontSize: 14,
                background: "none",
                border: "none",
                cursor: "pointer",
                fontFamily: "inherit",
                color: "var(--color-t-primary)",
              }}
            >
              <span className="flex-1 truncate" style={{ fontWeight: 500 }}>
                {entry.question}
              </span>
              <div className="flex items-center gap-2 shrink-0 ml-3">
                <span style={{ fontSize: 11, color: "var(--color-t-tertiary)" }}>
                  {new Date(entry.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: "var(--color-t-tertiary)",
                    transform: expandedIndex === i ? "rotate(180deg)" : "rotate(0deg)",
                    transition: "transform 0.2s",
                  }}
                >
                  ▾
                </span>
              </div>
            </button>
            {expandedIndex === i && (
              <div
                style={{
                  padding: "8px 14px 12px",
                  borderTop: "1px solid var(--color-border-default)",
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    color: "var(--color-t-secondary)",
                    marginBottom: 8,
                  }}
                >
                  {summarizeSpecContent(entry.spec)}
                </div>
                <button
                  onClick={() => onReplay(entry.question)}
                  style={{
                    fontSize: 13,
                    color: "var(--color-accent)",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    padding: 0,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.textDecoration = "underline";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.textDecoration = "none";
                  }}
                >
                  Re-run this question →
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Extract a brief summary from a spec (count of components, types used) */
function summarizeSpecContent(spec: Spec): string {
  if (!spec?.elements) return "Dashboard";
  const types = new Set<string>();
  let count = 0;
  for (const el of Object.values(spec.elements)) {
    if (el && typeof el === "object" && "type" in el) {
      const t = (el as { type: string }).type;
      if (!t.startsWith("Layout")) {
        types.add(t);
        count++;
      }
    }
  }
  if (count === 0) return "Dashboard";
  const typeList = Array.from(types).slice(0, 4).join(", ");
  return `${count} components: ${typeList}${types.size > 4 ? "..." : ""}`;
}
