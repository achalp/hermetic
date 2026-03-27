"use client";

import { useState } from "react";

interface SavedConn {
  id: string;
  type: string;
  name: string;
  host: string;
}

interface SourceCardsProps {
  onFileDrop: () => void;
  onWarehouseClick: () => void;
  onSampleData?: () => void;
  savedConnections?: SavedConn[];
  onSavedConnect?: (id: string) => void;
}

const dotColors: Record<string, string> = {
  postgresql: "#3b82f6",
  bigquery: "#f59e0b",
  clickhouse: "#10b981",
  trino: "#8b5cf6",
  hive: "#d97706",
};

const cardBase =
  "source-card-hover flex flex-col items-center gap-3 cursor-pointer text-center transition-all duration-200";

export function SourceCards({
  onFileDrop,
  onWarehouseClick,
  onSampleData,
  savedConnections,
  onSavedConnect,
}: SourceCardsProps) {
  const [showSaved, setShowSaved] = useState(false);
  const hasSaved = savedConnections && savedConnections.length > 0;

  return (
    <div
      className="source-cards-grid grid w-full"
      style={{ gridTemplateColumns: "1fr 1fr", gap: 16, maxWidth: 700 }}
    >
      {/* Upload a file */}
      <button
        onClick={onFileDrop}
        className={cardBase}
        style={{
          background: "var(--color-surface-1)",
          border: "2px dashed var(--color-border-default)",
          borderRadius: "var(--radius-card)",
          padding: "40px 32px",
        }}
      >
        <div
          className="flex items-center justify-center rounded-full"
          style={{ width: 48, height: 48, background: "var(--color-accent)" }}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            width="22"
            height="22"
            style={{ color: "white" }}
          >
            <path d="M12 16V4m0 0l-4 4m4-4l4 4" />
            <path d="M20 16v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2" />
          </svg>
        </div>
        <span style={{ fontSize: 16, fontWeight: 600, color: "var(--color-t-primary)" }}>
          Upload a file
        </span>
        <span style={{ fontSize: 13, color: "var(--color-t-secondary)" }}>
          CSV &middot; Excel &middot; JSON &middot; GeoJSON
        </span>
      </button>

      {/* Connect a warehouse — with saved connections tray */}
      <div
        style={{
          background: "var(--color-surface-1)",
          border: "2px solid var(--color-border-default)",
          borderRadius: "var(--radius-card)",
          overflow: "hidden",
          transition: "border-color 0.2s",
        }}
        onMouseEnter={() => {
          if (hasSaved) setShowSaved(true);
        }}
        onMouseLeave={() => setShowSaved(false)}
        onTouchStart={() => {
          if (hasSaved) setShowSaved((v) => !v);
        }}
      >
        {/* Main clickable area */}
        <button
          onClick={onWarehouseClick}
          className="flex flex-col items-center gap-3 cursor-pointer text-center transition-all duration-200 w-full"
          style={{
            background: "transparent",
            border: "none",
            padding: "40px 32px",
            ...(hasSaved ? { paddingBottom: 24 } : {}),
          }}
        >
          <div
            className="flex items-center justify-center rounded-full"
            style={{ width: 48, height: 48, background: "var(--color-accent)" }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              width="22"
              height="22"
              style={{ color: "white" }}
            >
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
              <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
            </svg>
          </div>
          <span style={{ fontSize: 16, fontWeight: 600, color: "var(--color-t-primary)" }}>
            Connect a warehouse
          </span>
          <span style={{ fontSize: 13, color: "var(--color-t-secondary)" }}>
            PostgreSQL &middot; BigQuery &middot; ClickHouse &middot; Trino &middot; Hive
          </span>
        </button>

        {/* Saved connections tray — revealed on hover/touch */}
        {hasSaved && (
          <div
            style={{
              maxHeight: showSaved ? 120 : 0,
              opacity: showSaved ? 1 : 0,
              overflow: "hidden",
              transition: "max-height 0.25s ease, opacity 0.2s ease",
              borderTop: showSaved
                ? "1px solid var(--color-border-default)"
                : "1px solid transparent",
            }}
          >
            <div style={{ padding: "10px 16px" }}>
              <div
                style={{
                  fontSize: 10,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: "var(--color-t-tertiary)",
                  marginBottom: 6,
                }}
              >
                Saved
              </div>
              <div className="flex flex-wrap gap-1.5">
                {savedConnections.map((c) => (
                  <button
                    key={c.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSavedConnect?.(c.id);
                    }}
                    className="flex items-center gap-1.5 transition-colors"
                    style={{
                      padding: "3px 10px",
                      borderRadius: 99,
                      border: "none",
                      background: "var(--color-accent-subtle)",
                      color: "var(--color-accent-text)",
                      cursor: "pointer",
                      fontFamily: "inherit",
                      fontSize: 11,
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: dotColors[c.type] ?? "var(--color-t-tertiary)",
                        flexShrink: 0,
                      }}
                    />
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Small indicator when tray is hidden */}
        {hasSaved && !showSaved && (
          <div
            style={{
              padding: "0 0 10px",
              textAlign: "center",
              fontSize: 11,
              color: "var(--color-t-tertiary)",
            }}
          >
            {savedConnections.length} saved
          </div>
        )}
      </div>

      {onSampleData && (
        <button
          onClick={onSampleData}
          className="transition-colors"
          style={{
            gridColumn: "1 / -1",
            padding: "12px",
            fontSize: 14,
            color: "var(--color-accent)",
            background: "none",
            border: "none",
            cursor: "pointer",
            fontFamily: "inherit",
            textAlign: "center",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.textDecoration = "underline";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.textDecoration = "none";
          }}
        >
          or try with sample data →
        </button>
      )}
    </div>
  );
}
