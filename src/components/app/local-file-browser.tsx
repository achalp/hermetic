"use client";

import { useState, useEffect, useCallback } from "react";
import { browseLocalFiles, type LocalFileEntry } from "@/lib/api";

interface LocalFileBrowserProps {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string, type: "file" | "folder") => void;
  isExtracting?: boolean;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

const extensionColors: Record<string, string> = {
  ".parquet": "#8b5cf6",
  ".csv": "#3b82f6",
  ".xlsx": "#10b981",
  ".geojson": "#f59e0b",
  ".json": "#f59e0b",
};

export function LocalFileBrowser({ open, onClose, onSelect, isExtracting }: LocalFileBrowserProps) {
  const [currentPath, setCurrentPath] = useState<string>("");
  const [entries, setEntries] = useState<LocalFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<LocalFileEntry | null>(null);

  const navigate = useCallback(async (path?: string) => {
    setLoading(true);
    setError(null);
    setSelectedEntry(null);
    try {
      const result = await browseLocalFiles(path);
      setCurrentPath(result.path);
      setEntries(result.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to browse");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && !currentPath) {
      navigate();
    }
  }, [open, currentPath, navigate]);

  if (!open) return null;

  const pathSegments = currentPath.split("/").filter(Boolean);

  const handleEntryClick = (entry: LocalFileEntry) => {
    if (entry.isDirectory && !entry.isParquetFolder) {
      navigate(entry.path);
    } else {
      setSelectedEntry(entry);
    }
  };

  const handleSelect = () => {
    if (!selectedEntry) return;
    const type = selectedEntry.isDirectory ? "folder" : "file";
    onSelect(selectedEntry.path, type);
  };

  const goUp = () => {
    const parent = currentPath.split("/").slice(0, -1).join("/") || "/";
    navigate(parent);
  };

  const ONE_GB = 1024 * 1024 * 1024;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.5)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isExtracting) onClose();
      }}
    >
      <div
        style={{
          background: "var(--color-surface-1)",
          borderRadius: "var(--radius-card)",
          border: "1px solid var(--color-border-default)",
          width: "100%",
          maxWidth: 640,
          maxHeight: "80vh",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "16px 20px",
            borderBottom: "1px solid var(--color-border-default)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span style={{ fontSize: 16, fontWeight: 600, color: "var(--color-t-primary)" }}>
            Browse local files
          </span>
          <button
            onClick={onClose}
            disabled={isExtracting}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--color-t-tertiary)",
              fontSize: 20,
              padding: "0 4px",
              fontFamily: "inherit",
            }}
          >
            &times;
          </button>
        </div>

        {/* Breadcrumb path */}
        <div
          style={{
            padding: "10px 20px",
            borderBottom: "1px solid var(--color-border-default)",
            display: "flex",
            alignItems: "center",
            gap: 4,
            flexWrap: "wrap",
            fontSize: 13,
            color: "var(--color-t-secondary)",
          }}
        >
          <button
            onClick={goUp}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--color-t-tertiary)",
              fontSize: 13,
              padding: "2px 4px",
              fontFamily: "inherit",
            }}
          >
            ..
          </button>
          <span>/</span>
          {pathSegments.map((seg, i) => {
            const segPath = "/" + pathSegments.slice(0, i + 1).join("/");
            return (
              <span key={segPath} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <button
                  onClick={() => navigate(segPath)}
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color:
                      i === pathSegments.length - 1
                        ? "var(--color-t-primary)"
                        : "var(--color-accent)",
                    fontSize: 13,
                    padding: "2px 4px",
                    fontFamily: "inherit",
                    fontWeight: i === pathSegments.length - 1 ? 600 : 400,
                  }}
                >
                  {seg}
                </button>
                {i < pathSegments.length - 1 && <span>/</span>}
              </span>
            );
          })}
        </div>

        {/* File list */}
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "8px 0",
          }}
        >
          {loading && (
            <div
              style={{
                padding: "40px 20px",
                textAlign: "center",
                color: "var(--color-t-tertiary)",
              }}
            >
              Loading...
            </div>
          )}
          {error && (
            <div
              style={{ padding: "40px 20px", textAlign: "center", color: "var(--color-danger)" }}
            >
              {error}
            </div>
          )}
          {!loading && !error && entries.length === 0 && (
            <div
              style={{
                padding: "40px 20px",
                textAlign: "center",
                color: "var(--color-t-tertiary)",
              }}
            >
              No data files found in this directory
            </div>
          )}
          {!loading &&
            !error &&
            entries.map((entry) => {
              const isSelected = selectedEntry?.path === entry.path;
              const isParquetDir = entry.isDirectory && entry.isParquetFolder;

              return (
                <button
                  key={entry.path}
                  onClick={() => handleEntryClick(entry)}
                  onDoubleClick={() => {
                    if (entry.isDirectory && !entry.isParquetFolder) {
                      navigate(entry.path);
                    }
                  }}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    width: "100%",
                    padding: "8px 20px",
                    background: isSelected ? "var(--color-accent-subtle)" : "transparent",
                    border: "none",
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "inherit",
                    fontSize: 14,
                    color: "var(--color-t-primary)",
                    transition: "background 0.1s",
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected)
                      e.currentTarget.style.background = "var(--color-surface-2, rgba(0,0,0,0.03))";
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) e.currentTarget.style.background = "transparent";
                  }}
                >
                  {/* Icon */}
                  <span style={{ fontSize: 16, width: 20, textAlign: "center", flexShrink: 0 }}>
                    {entry.isDirectory ? (isParquetDir ? "\u{1F4C2}" : "\u{1F4C1}") : "\u{1F4C4}"}
                  </span>

                  {/* Name */}
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {entry.name}
                  </span>

                  {/* Parquet folder badge */}
                  {isParquetDir && (
                    <span
                      style={{
                        fontSize: 10,
                        padding: "1px 6px",
                        borderRadius: 4,
                        background: extensionColors[".parquet"],
                        color: "white",
                        fontWeight: 600,
                        flexShrink: 0,
                      }}
                    >
                      {entry.isHivePartitioned ? "HIVE PARQUET" : "PARQUET"}
                    </span>
                  )}

                  {/* Extension badge */}
                  {!entry.isDirectory && entry.extension && (
                    <span
                      style={{
                        fontSize: 10,
                        padding: "1px 6px",
                        borderRadius: 4,
                        background: extensionColors[entry.extension] ?? "var(--color-t-tertiary)",
                        color: "white",
                        fontWeight: 600,
                        flexShrink: 0,
                      }}
                    >
                      {entry.extension.replace(".", "").toUpperCase()}
                    </span>
                  )}

                  {/* Size */}
                  {!entry.isDirectory && entry.size !== undefined && (
                    <span
                      style={{
                        fontSize: 12,
                        color: "var(--color-t-tertiary)",
                        flexShrink: 0,
                        minWidth: 60,
                        textAlign: "right",
                      }}
                    >
                      {formatSize(entry.size)}
                    </span>
                  )}
                </button>
              );
            })}
        </div>

        {/* Large file info */}
        {selectedEntry &&
          !selectedEntry.isDirectory &&
          selectedEntry.size &&
          selectedEntry.size > ONE_GB && (
            <div
              style={{
                padding: "8px 20px",
                fontSize: 12,
                color: "var(--color-t-secondary)",
                borderTop: "1px solid var(--color-border-default)",
                background: "var(--color-accent-subtle)",
              }}
            >
              File is {(selectedEntry.size / ONE_GB).toFixed(1)} GB. DuckDB will stream it
              efficiently.
            </div>
          )}

        {/* Footer */}
        <div
          style={{
            padding: "12px 20px",
            borderTop: "1px solid var(--color-border-default)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span
            style={{
              fontSize: 13,
              color: "var(--color-t-tertiary)",
              flex: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {selectedEntry ? selectedEntry.path : "Select a file or Parquet folder"}
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={onClose}
              disabled={isExtracting}
              style={{
                padding: "8px 16px",
                borderRadius: 6,
                border: "1px solid var(--color-border-default)",
                background: "transparent",
                color: "var(--color-t-secondary)",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 13,
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleSelect}
              disabled={!selectedEntry || isExtracting}
              style={{
                padding: "8px 16px",
                borderRadius: 6,
                border: "none",
                background:
                  selectedEntry && !isExtracting
                    ? "var(--color-accent)"
                    : "var(--color-border-default)",
                color: selectedEntry && !isExtracting ? "white" : "var(--color-t-tertiary)",
                cursor: selectedEntry && !isExtracting ? "pointer" : "not-allowed",
                fontFamily: "inherit",
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {isExtracting ? "Extracting schema..." : "Select"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
