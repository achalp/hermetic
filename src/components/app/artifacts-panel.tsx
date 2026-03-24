"use client";

import { useState } from "react";

interface ArtifactsPanelProps {
  open: boolean;
  fullscreen: boolean;
  onClose: () => void;
  onToggleFullscreen: () => void;
  artifacts: {
    sql?: string;
    code?: string;
    data?: { columns: string[]; rows: string[][] };
  };
}

type TabId = "sql" | "code" | "data";

export function ArtifactsPanel({
  open,
  fullscreen,
  onClose,
  onToggleFullscreen,
  artifacts,
}: ArtifactsPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>("sql");

  const tabs: { id: TabId; label: string }[] = [
    { id: "sql", label: "SQL" },
    { id: "code", label: "Code" },
    { id: "data", label: "Data" },
  ];

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

      {/* Panel */}
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
          transition: "transform 0.3s, height 0.3s",
          borderRadius: fullscreen ? 0 : "12px 12px 0 0",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Header */}
        <div
          className="flex flex-row items-center justify-between"
          style={{ padding: "16px 24px 0" }}
        >
          <span style={{ fontSize: 14, fontWeight: 600 }}>Artifacts</span>
          <div className="flex flex-row items-center" style={{ gap: 8 }}>
            <button
              onClick={onToggleFullscreen}
              aria-label="Toggle fullscreen"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "inherit",
                padding: 4,
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />
              </svg>
            </button>
            <button
              onClick={onClose}
              aria-label="Close"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "inherit",
                fontSize: 18,
                padding: 4,
              }}
            >
              &times;
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex flex-row" style={{ padding: "12px 24px 0" }}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                background: "none",
                border: "none",
                borderBottom: `2px solid ${activeTab === tab.id ? "var(--color-accent)" : "transparent"}`,
                color: activeTab === tab.id ? "var(--color-accent)" : "inherit",
                fontSize: 13,
                padding: "10px 16px",
                cursor: "pointer",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
          {activeTab === "sql" && (
            <pre
              style={{
                fontFamily: "monospace",
                fontSize: 13,
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                color: "var(--color-surface-dark-text2)",
                margin: 0,
              }}
            >
              {artifacts.sql || "No SQL generated"}
            </pre>
          )}
          {activeTab === "code" && (
            <pre
              style={{
                fontFamily: "monospace",
                fontSize: 13,
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                color: "var(--color-surface-dark-text2)",
                margin: 0,
              }}
            >
              {artifacts.code || "No code generated"}
            </pre>
          )}
          {activeTab === "data" &&
            (artifacts.data ? (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {artifacts.data.columns.map((col) => (
                      <th
                        key={col}
                        style={{
                          fontSize: 11,
                          textTransform: "uppercase",
                          color: "var(--color-surface-dark-text3)",
                          padding: "8px 12px",
                          textAlign: "left",
                        }}
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {artifacts.data.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td
                          key={j}
                          style={{
                            fontSize: 12,
                            color: "var(--color-surface-dark-text2)",
                            padding: "6px 12px",
                          }}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p style={{ fontSize: 13, color: "var(--color-surface-dark-text2)", margin: 0 }}>
                No data available
              </p>
            ))}
        </div>
      </div>
    </>
  );
}
