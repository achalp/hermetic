"use client";

import { useState, type ReactNode } from "react";

interface CollapsibleSectionProps {
  /** Title shown in the header */
  title: ReactNode;
  /** Optional metadata shown next to the chevron */
  meta?: ReactNode;
  /** Whether to start collapsed */
  defaultCollapsed?: boolean;
  /** Parent-controlled collapse (drives closed when true) */
  collapsed?: boolean;
  children: ReactNode;
}

export function CollapsibleSection({
  title,
  meta,
  defaultCollapsed = false,
  collapsed,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(!defaultCollapsed);

  // Sync with parent-controlled collapsed prop
  const [prevCollapsed, setPrevCollapsed] = useState(collapsed);
  if (collapsed !== undefined && collapsed !== prevCollapsed) {
    setPrevCollapsed(collapsed);
    if (collapsed) setOpen(false);
  }

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
        aria-expanded={open}
      >
        <h3 className="text-sm font-semibold text-t-secondary">{title}</h3>
        <div className="flex items-center gap-2">
          {meta && <span className="text-xs text-t-tertiary">{meta}</span>}
          <span
            className="text-xs text-t-tertiary transition-transform duration-200"
            style={{
              display: "inline-block",
              transform: open ? "rotate(180deg)" : "rotate(0deg)",
            }}
            aria-hidden="true"
          >
            &#9660;
          </span>
        </div>
      </button>

      {open && <div className="mt-3">{children}</div>}
    </div>
  );
}
