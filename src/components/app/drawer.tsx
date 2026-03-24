"use client";

import { useEffect, type ReactNode } from "react";

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  width?: number;
  children: ReactNode;
}

export function Drawer({ open, onClose, title, width = 360, children }: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  return (
    <>
      {/* Overlay */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.15)",
          zIndex: "var(--z-drawer-overlay)",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 0.3s",
        }}
      />

      {/* Drawer panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width,
          background: "var(--color-surface-dark)",
          color: "var(--color-surface-dark-text)",
          zIndex: "var(--z-drawer)",
          transform: open ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.3s ease",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between shrink-0"
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--color-surface-dark-2)",
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 600, color: "#fff" }}>{title}</span>
          <button
            onClick={onClose}
            className="flex items-center justify-center"
            style={{
              fontSize: 20,
              color: "#999",
              background: "none",
              border: "none",
              cursor: "pointer",
              lineHeight: 1,
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#fff")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#999")}
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </>
  );
}
