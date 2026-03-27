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
  onRemove: (timestamp: number) => void;
}

export type { HistoryEntry };

export function AnalysisHistory({ entries, onReplay, onRemove }: AnalysisHistoryProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);

  if (entries.length === 0) return null;

  const visible = showAll ? entries : entries.slice(-3);
  const hiddenCount = entries.length - 3;

  return (
    <div className="mb-6">
      <div
        style={{
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: "var(--color-t-tertiary)",
          marginBottom: 8,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>Previous analyses ({entries.length})</span>
        {hiddenCount > 0 && !showAll && (
          <button
            onClick={() => setShowAll(true)}
            style={{
              fontSize: 11,
              color: "var(--color-accent)",
              background: "none",
              border: "none",
              cursor: "pointer",
              fontFamily: "inherit",
              textTransform: "none",
              letterSpacing: "normal",
            }}
          >
            Show all
          </button>
        )}
        {showAll && hiddenCount > 0 && (
          <button
            onClick={() => setShowAll(false)}
            style={{
              fontSize: 11,
              color: "var(--color-t-tertiary)",
              background: "none",
              border: "none",
              cursor: "pointer",
              fontFamily: "inherit",
              textTransform: "none",
              letterSpacing: "normal",
            }}
          >
            Show less
          </button>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {visible.map((entry) => {
          const idx = entries.indexOf(entry);
          const isExpanded = expandedIndex === idx;
          return (
            <div
              key={entry.timestamp}
              style={{
                border: "1px solid var(--color-border-default)",
                borderRadius: "var(--radius-card)",
                background: "var(--color-surface-1)",
                overflow: "hidden",
              }}
            >
              <div
                className="flex w-full items-center text-left"
                style={{ padding: "8px 10px 8px 14px", gap: 8 }}
              >
                <button
                  onClick={() => setExpandedIndex(isExpanded ? null : idx)}
                  className="flex flex-1 items-center justify-between transition-colors"
                  style={{
                    fontSize: 13,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    color: "var(--color-t-primary)",
                    padding: 0,
                    textAlign: "left",
                    minWidth: 0,
                  }}
                >
                  <span className="flex-1 truncate" style={{ fontWeight: 500 }}>
                    {entry.question}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: "var(--color-t-tertiary)",
                      flexShrink: 0,
                      marginLeft: 8,
                    }}
                  >
                    {new Date(entry.timestamp).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </button>
                {/* Delete button */}
                <button
                  onClick={() => onRemove(entry.timestamp)}
                  title="Remove"
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--color-t-tertiary)",
                    fontSize: 14,
                    padding: "2px 4px",
                    lineHeight: 1,
                    flexShrink: 0,
                    transition: "color 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.color = "var(--color-error-text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = "var(--color-t-tertiary)";
                  }}
                >
                  ×
                </button>
              </div>
              {isExpanded && (
                <div
                  style={{
                    padding: "4px 14px 10px",
                    borderTop: "1px solid var(--color-border-default)",
                  }}
                >
                  <div style={{ fontSize: 12, color: "var(--color-t-secondary)", marginBottom: 6 }}>
                    {summarizeSpecContent(entry.spec)}
                  </div>
                  <button
                    onClick={() => onReplay(entry.question)}
                    style={{
                      fontSize: 12,
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
                    Re-run →
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

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
