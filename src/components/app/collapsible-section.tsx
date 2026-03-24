"use client";

import { useState, useId, type ReactNode } from "react";

interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

export function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();

  return (
    <div>
      {/* Header */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between"
        style={{
          padding: "16px 20px 12px",
          cursor: "pointer",
          userSelect: "none",
          background: "none",
          border: "none",
        }}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <span
          style={{
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--color-surface-dark-text4)",
          }}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: 12,
            color: "var(--color-surface-dark-text4)",
            transition: "transform 0.25s ease",
            transform: open ? "rotate(0deg)" : "rotate(-90deg)",
            display: "inline-block",
          }}
        >
          &#9662;
        </span>
      </button>

      {/* Collapsible body */}
      <div
        id={bodyId}
        style={{
          display: "grid",
          gridTemplateRows: open ? "1fr" : "0fr",
          transition: "grid-template-rows 0.25s ease",
        }}
      >
        <div style={{ overflow: "hidden" }}>
          <div style={{ padding: "0 20px 16px" }}>{children}</div>
        </div>
      </div>
    </div>
  );
}
