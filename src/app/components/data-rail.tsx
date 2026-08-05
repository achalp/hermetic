"use client";

import { ReactNode } from "react";

interface DataRailProps {
  visible: boolean;
  expanded: boolean;
  fullscreen: boolean;
  onExpand: () => void;
  onCollapse: () => void;
  onToggleFullscreen: () => void;
  children: ReactNode;
}

export function DataRail({
  visible,
  expanded,
  fullscreen,
  onExpand,
  onCollapse,
  onToggleFullscreen,
  children,
}: DataRailProps) {
  if (!visible) return null;

  const width = fullscreen ? "100vw" : expanded ? 380 : 48;
  const zIndex = fullscreen ? 250 : 180;

  return (
    <div
      style={{
        position: "fixed",
        top: 56,
        right: 0,
        bottom: 0,
        width,
        zIndex,
        background: "var(--color-surface-dark)",
        borderLeft: expanded ? "none" : "1px solid var(--color-border-default)",
        transition: "width 0.3s ease",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Collapsed icon strip */}
      {!expanded && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            paddingTop: 16,
            gap: 4,
            flex: 1,
          }}
        >
          <IconButton onClick={onExpand}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              width={18}
              height={18}
            >
              <rect x="3" y="3" width="18" height="4" rx="1" />
              <rect x="3" y="10" width="18" height="4" rx="1" />
              <rect x="3" y="17" width="18" height="4" rx="1" />
            </svg>
          </IconButton>
          <IconButton onClick={onExpand}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              width={18}
              height={18}
            >
              <rect x="4" y="14" width="4" height="7" rx="1" />
              <rect x="10" y="10" width="4" height="11" rx="1" />
              <rect x="16" y="6" width="4" height="15" rx="1" />
            </svg>
          </IconButton>
          <IconButton onClick={onExpand}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              width={18}
              height={18}
            >
              <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
              <polyline points="14,2 14,8 20,8" />
              <line x1="8" y1="13" x2="16" y2="13" />
              <line x1="8" y1="17" x2="16" y2="17" />
            </svg>
          </IconButton>
          <div style={{ flex: 1 }} />
          <IconButton onClick={onExpand} style={{ marginBottom: 16 }}>
            <span style={{ fontSize: 18, lineHeight: 1 }}>{"\u2039"}</span>
          </IconButton>
        </div>
      )}

      {/* Expanded content */}
      {expanded && (
        <>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "18px 20px",
              borderBottom: "1px solid var(--color-surface-dark-2)",
            }}
          >
            <span
              style={{ fontSize: 14, fontWeight: 600, color: "var(--color-surface-dark-text)" }}
            >
              Data Explorer
            </span>
            <div style={{ display: "flex", gap: 4 }}>
              <IconButton onClick={onToggleFullscreen}>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  width={16}
                  height={16}
                >
                  <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
                </svg>
              </IconButton>
              <IconButton onClick={onCollapse}>
                <span style={{ fontSize: 18, lineHeight: 1 }}>{"\u203A"}</span>
              </IconButton>
            </div>
          </div>
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              opacity: expanded ? 1 : 0,
              transition: "opacity 0.2s ease 0.1s",
            }}
          >
            {children}
          </div>
        </>
      )}
    </div>
  );
}

function IconButton({
  onClick,
  children,
  style,
}: {
  onClick: () => void;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <button
      onClick={onClick}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--color-surface-dark-2)";
        e.currentTarget.style.color = "var(--color-surface-dark-text)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "none";
        e.currentTarget.style.color = "var(--color-surface-dark-text3)";
      }}
      style={{
        width: 32,
        height: 32,
        borderRadius: "var(--radius-button)",
        background: "none",
        border: "none",
        color: "var(--color-surface-dark-text3)",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        ...style,
      }}
    >
      {children}
    </button>
  );
}
