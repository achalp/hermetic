"use client";

import type { CachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import { ArtifactsViewer } from "./artifacts-viewer";

interface ArtifactsPanelProps {
  open: boolean;
  fullscreen: boolean;
  onClose: () => void;
  onToggleFullscreen: () => void;
  artifacts: CachedArtifacts | null;
}

export function ArtifactsPanel({
  open,
  fullscreen,
  onClose,
  onToggleFullscreen,
  artifacts,
}: ArtifactsPanelProps) {
  return (
    <>
      {/* Overlay */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.3)",
          zIndex: "var(--z-artifacts-overlay)" as never,
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 0.3s",
        }}
      />

      {/* Bottom sheet — dark surface per design spec */}
      <div
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          height: fullscreen ? "calc(100vh - 56px)" : "55vh",
          background: "var(--color-surface-dark)",
          color: "var(--color-surface-dark-text)",
          zIndex: "var(--z-artifacts)" as never,
          transform: open ? "translateY(0)" : "translateY(100%)",
          transition: "transform 0.3s ease, height 0.3s ease",
          borderRadius: fullscreen ? 0 : "12px 12px 0 0",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between"
          style={{
            padding: "12px 24px",
            borderBottom: "1px solid var(--color-surface-dark-2)",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600 }}>Artifacts</span>
          <div className="flex items-center" style={{ gap: 8 }}>
            <button
              onClick={onToggleFullscreen}
              aria-label="Toggle fullscreen"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 4,
                color: "var(--color-surface-dark-text3)",
                transition: "color 0.15s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--color-surface-dark-text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--color-surface-dark-text3)";
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
              </svg>
            </button>
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontSize: 20,
                padding: 4,
                lineHeight: 1,
                color: "var(--color-surface-dark-text3)",
                transition: "color 0.15s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "var(--color-surface-dark-text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--color-surface-dark-text3)";
              }}
            >
              ×
            </button>
          </div>
        </div>

        {/* Body — ArtifactsViewer with dark surface override */}
        <div className="dark-surface-override" style={{ flex: 1, overflow: "auto" }}>
          {artifacts ? (
            <ArtifactsViewer artifacts={artifacts} />
          ) : (
            <div
              className="flex items-center justify-center h-full"
              style={{ fontSize: 13, color: "var(--color-surface-dark-text3)" }}
            >
              No artifacts available. Run a query first.
            </div>
          )}
        </div>
      </div>
    </>
  );
}
