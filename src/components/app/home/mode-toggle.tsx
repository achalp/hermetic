"use client";

import { useCallback } from "react";
import type { QueryMode } from "@/components/app/query-input";

const MODES: { id: QueryMode; label: string }[] = [
  { id: "ask", label: "Ask" },
  { id: "investigate", label: "Investigate" },
];

interface ModeToggleProps {
  mode: QueryMode;
  onModeChange: (mode: QueryMode) => void;
  disabled?: boolean;
}

/**
 * Ask | Investigate as a visible segmented control (radiogroup), replacing the
 * easy-to-miss <select>. Depth/cost is a decision users must SEE at the moment
 * of commitment; arrow keys move between options per the WAI radio pattern.
 */
export function ModeToggle({ mode, onModeChange, disabled }: ModeToggleProps) {
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const idx = MODES.findIndex((m) => m.id === mode);
      const next = MODES[(idx + (e.key === "ArrowRight" ? 1 : MODES.length - 1)) % MODES.length];
      onModeChange(next.id);
    },
    [mode, onModeChange]
  );

  return (
    <div
      role="radiogroup"
      aria-label="Analysis depth"
      onKeyDown={handleKeyDown}
      className="flex gap-0.5 border border-border-default"
      style={{
        padding: 3,
        background: "var(--color-surface-2)",
        borderRadius: "var(--radius-button)",
      }}
    >
      {MODES.map((m) => {
        const selected = m.id === mode;
        return (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            onClick={() => onModeChange(m.id)}
            className="cursor-pointer border-none text-sm font-semibold transition-colors disabled:opacity-50"
            style={{
              minHeight: 34,
              padding: "0 13px",
              borderRadius: "calc(var(--radius-button) - 2px)",
              background: selected ? "var(--color-surface-1)" : "transparent",
              color: selected ? "var(--color-t-primary)" : "var(--color-t-secondary)",
              boxShadow: selected ? "var(--shadow-sm, 0 1px 2px rgb(0 0 0 / 0.12))" : "none",
            }}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
