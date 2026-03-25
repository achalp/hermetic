"use client";

import { useState, useCallback } from "react";
import type { CachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import { tokenizePython, type TokenType } from "@/lib/syntax-highlight";
import { downloadTableAsCsv, downloadTableAsXlsx } from "@/lib/export-utils";

const TOKEN_STYLES: Record<TokenType, React.CSSProperties | undefined> = {
  comment: { color: "var(--syntax-comment)", fontStyle: "italic" },
  string: { color: "var(--syntax-string)" },
  keyword: { color: "var(--syntax-keyword)", fontWeight: 600 },
  builtin: { color: "var(--syntax-builtin)" },
  number: { color: "var(--syntax-number)" },
  plain: undefined,
};

interface ArtifactsPanelProps {
  open: boolean;
  fullscreen: boolean;
  onClose: () => void;
  onToggleFullscreen: () => void;
  artifacts: CachedArtifacts | null;
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
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    const text = activeTab === "sql" ? artifacts?.sql : artifacts?.code;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [activeTab, artifacts]);

  const tabs: { id: TabId; label: string }[] = [
    { id: "sql", label: "SQL" },
    { id: "code", label: "Python" },
    { id: "data", label: "Data" },
  ];

  // Extract first dataset for the data tab
  const dataEntries = artifacts?.datasets
    ? Object.entries(artifacts.datasets).filter(([, v]) => Array.isArray(v) && v.length > 0)
    : [];
  const firstDataset = dataEntries[0];
  const dataRows = firstDataset ? (firstDataset[1] as Record<string, unknown>[]) : null;
  const dataColumns = dataRows?.[0] ? Object.keys(dataRows[0]) : [];

  const preStyle: React.CSSProperties = {
    fontFamily: "'SF Mono', Menlo, Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    margin: 0,
    color: "var(--color-surface-dark-text2)",
  };

  const btnStyle: React.CSSProperties = {
    fontSize: 12,
    padding: "4px 12px",
    borderRadius: "var(--radius-button)",
    border: "1px solid var(--color-surface-dark-3)",
    background: "var(--color-surface-dark-2)",
    color: "var(--color-surface-dark-text2)",
    cursor: "pointer",
    fontFamily: "inherit",
  };

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
          className="flex items-center justify-between"
          style={{ padding: "14px 24px", borderBottom: "1px solid var(--color-surface-dark-2)" }}
        >
          <span style={{ fontSize: 14, fontWeight: 600 }}>Artifacts</span>
          <div className="flex items-center" style={{ gap: 8 }}>
            {/* Copy button (for sql/code tabs) */}
            {(activeTab === "sql" || activeTab === "code") && (
              <button onClick={handleCopy} style={btnStyle}>
                {copied ? "✓ Copied" : "Copy"}
              </button>
            )}
            {/* Export buttons (for data tab) */}
            {activeTab === "data" && dataRows && (
              <>
                <button
                  onClick={() =>
                    downloadTableAsCsv(
                      dataColumns,
                      dataRows.map((r) => dataColumns.map((c) => String(r[c] ?? ""))),
                      "artifacts"
                    )
                  }
                  style={btnStyle}
                >
                  CSV
                </button>
                <button
                  onClick={() =>
                    downloadTableAsXlsx(
                      dataColumns,
                      dataRows.map((r) => dataColumns.map((c) => String(r[c] ?? ""))),
                      "artifacts"
                    )
                  }
                  style={btnStyle}
                >
                  XLSX
                </button>
              </>
            )}
            <button
              onClick={onToggleFullscreen}
              aria-label="Toggle fullscreen"
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--color-surface-dark-text3)",
                padding: 4,
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
                color: "var(--color-surface-dark-text3)",
                fontSize: 20,
                padding: 4,
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div
          className="flex"
          style={{ padding: "0 24px", borderBottom: "1px solid var(--color-surface-dark-2)" }}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                setActiveTab(tab.id);
                setCopied(false);
              }}
              style={{
                background: "none",
                border: "none",
                borderBottom: `2px solid ${activeTab === tab.id ? "var(--color-accent)" : "transparent"}`,
                color:
                  activeTab === tab.id ? "var(--color-accent)" : "var(--color-surface-dark-text3)",
                fontSize: 13,
                padding: "10px 16px",
                cursor: "pointer",
                fontFamily: "inherit",
                transition: "color 0.15s",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
          {activeTab === "sql" && (
            <pre style={preStyle}>
              {artifacts?.sql ? highlightSQL(artifacts.sql) : "No SQL generated"}
            </pre>
          )}
          {activeTab === "code" && (
            <pre style={preStyle}>
              {artifacts?.code
                ? tokenizePython(artifacts.code).map((token, i) => {
                    const style = TOKEN_STYLES[token.type];
                    return style ? (
                      <span key={i} style={style}>
                        {token.text}
                      </span>
                    ) : (
                      <span key={i}>{token.text}</span>
                    );
                  })
                : "No code generated"}
            </pre>
          )}
          {activeTab === "data" &&
            (dataRows && dataColumns.length > 0 ? (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      {dataColumns.map((col) => (
                        <th
                          key={col}
                          style={{
                            fontSize: 11,
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                            color: "var(--color-surface-dark-text3)",
                            padding: "8px 12px",
                            textAlign: "left",
                            fontWeight: 600,
                            borderBottom: "1px solid var(--color-surface-dark-2)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {col}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dataRows.slice(0, 100).map((row, i) => (
                      <tr key={i}>
                        {dataColumns.map((col) => (
                          <td
                            key={col}
                            style={{
                              fontSize: 12,
                              color: "var(--color-surface-dark-text2)",
                              padding: "6px 12px",
                              borderBottom: "1px solid var(--color-surface-dark-2)",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {String(row[col] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {dataRows.length > 100 && (
                  <p
                    style={{ fontSize: 12, color: "var(--color-surface-dark-text4)", marginTop: 8 }}
                  >
                    Showing 100 of {dataRows.length} rows
                  </p>
                )}
              </div>
            ) : (
              <p style={{ fontSize: 13, color: "var(--color-surface-dark-text3)" }}>
                No data available
              </p>
            ))}
        </div>
      </div>
    </>
  );
}

/** Simple SQL keyword highlighting */
function highlightSQL(sql: string): React.ReactNode[] {
  const keywords = new Set([
    "SELECT",
    "FROM",
    "WHERE",
    "AND",
    "OR",
    "NOT",
    "IN",
    "AS",
    "ON",
    "JOIN",
    "LEFT",
    "RIGHT",
    "INNER",
    "OUTER",
    "FULL",
    "CROSS",
    "GROUP",
    "BY",
    "ORDER",
    "HAVING",
    "LIMIT",
    "OFFSET",
    "UNION",
    "ALL",
    "INSERT",
    "INTO",
    "VALUES",
    "UPDATE",
    "SET",
    "DELETE",
    "CREATE",
    "TABLE",
    "ALTER",
    "DROP",
    "INDEX",
    "DISTINCT",
    "BETWEEN",
    "LIKE",
    "IS",
    "NULL",
    "TRUE",
    "FALSE",
    "CASE",
    "WHEN",
    "THEN",
    "ELSE",
    "END",
    "EXISTS",
    "COUNT",
    "SUM",
    "AVG",
    "MIN",
    "MAX",
    "CAST",
    "COALESCE",
    "WITH",
    "ASC",
    "DESC",
    "OVER",
    "PARTITION",
    "ROWS",
    "RANGE",
    "UNBOUNDED",
    "PRECEDING",
    "FOLLOWING",
    "CURRENT",
    "ROW",
  ]);

  // Split by word boundaries while preserving whitespace and symbols
  const tokens = sql.split(/(\b\w+\b|'[^']*'|"[^"]*"|\s+|.)/g).filter(Boolean);

  return tokens.map((token, i) => {
    if (keywords.has(token.toUpperCase())) {
      return (
        <span key={i} style={{ color: "var(--syntax-keyword)", fontWeight: 600 }}>
          {token}
        </span>
      );
    }
    if (/^'[^']*'$/.test(token) || /^"[^"]*"$/.test(token)) {
      return (
        <span key={i} style={{ color: "var(--syntax-string)" }}>
          {token}
        </span>
      );
    }
    if (/^\d+(\.\d+)?$/.test(token)) {
      return (
        <span key={i} style={{ color: "var(--syntax-number)" }}>
          {token}
        </span>
      );
    }
    if (token.startsWith("--")) {
      return (
        <span key={i} style={{ color: "var(--syntax-comment)", fontStyle: "italic" }}>
          {token}
        </span>
      );
    }
    return <span key={i}>{token}</span>;
  });
}
