"use client";

import { useState, useEffect, useMemo } from "react";
import Link from "next/link";
import { listHistory, deleteHistoryEntry } from "@/lib/api";
import type { HistoryMeta } from "@/lib/contracts/storage-types";

const SOURCE_TYPE_LABELS: Record<string, string> = {
  upload: "Upload",
  local: "Local",
  warehouse: "Warehouse",
};

const SOURCE_TYPE_COLORS: Record<string, string> = {
  upload: "#3b82f6",
  local: "#8b5cf6",
  warehouse: "#10b981",
};

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

type DateFilter = "all" | "today" | "week" | "month";

export default function HistoryPage() {
  const [entries, setEntries] = useState<HistoryMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [dateFilter, setDateFilter] = useState<DateFilter>("all");
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Load history on mount. `loading` is already initialized to true via
  // useState(true), so we don't need a synchronous setState in the effect
  // body (which the react-hooks/set-state-in-effect rule flags).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await listHistory();
        if (!cancelled) setEntries(data);
      } catch {
        if (!cancelled) setEntries([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteHistoryEntry(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
    } catch {
      // Ignore
    } finally {
      setDeletingId(null);
    }
  };

  // Client-side filtering. Wrapped in useMemo so the Date.now() call lives
  // in the memo callback instead of the render body (the
  // react/components-and-hooks-must-be-pure rule flags impure calls during
  // render, but allows them inside useMemo callbacks).
  const filtered = useMemo(() => {
    const now = Date.now();
    return entries.filter((e) => {
      // Text search
      if (search) {
        const q = search.toLowerCase();
        if (!e.question.toLowerCase().includes(q) && !e.sourceFile.toLowerCase().includes(q)) {
          return false;
        }
      }
      // Source type
      if (sourceFilter !== "all" && e.sourceType !== sourceFilter) return false;
      // Date range
      if (dateFilter === "today" && now - e.timestamp > 86_400_000) return false;
      if (dateFilter === "week" && now - e.timestamp > 604_800_000) return false;
      if (dateFilter === "month" && now - e.timestamp > 2_592_000_000) return false;
      return true;
    });
  }, [entries, search, sourceFilter, dateFilter]);

  // Collect unique chart types for display
  const allChartTypes = new Set<string>();
  entries.forEach((e) => e.chartTypes.forEach((t: string) => allChartTypes.add(t)));

  return (
    <div
      className="min-h-screen"
      style={{ background: "var(--color-bg)", color: "var(--color-t-primary)" }}
    >
      {/* Header */}
      <header
        className="fixed top-0 w-full h-14 border-b flex items-center justify-between px-6"
        style={{
          background: "var(--color-surface-1)",
          borderColor: "var(--color-border-default)",
          zIndex: 50,
        }}
      >
        <div className="flex items-center gap-4">
          <Link href="/" className="text-accent font-bold lowercase" style={{ fontSize: 16 }}>
            hermetic
          </Link>
          <span style={{ color: "var(--color-t-tertiary)" }}>/</span>
          <span style={{ fontSize: 15, fontWeight: 600 }}>History</span>
        </div>
        <span style={{ fontSize: 13, color: "var(--color-t-tertiary)" }}>
          {entries.length} {entries.length === 1 ? "analysis" : "analyses"}
        </span>
      </header>

      {/* Content */}
      <main
        style={{ paddingTop: 56 + 16, maxWidth: 900, margin: "0 auto", padding: "72px 24px 48px" }}
      >
        {/* Search + Filters */}
        <div className="flex flex-wrap items-center gap-3" style={{ marginBottom: 20 }}>
          <input
            type="text"
            placeholder="Search questions, files..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              flex: 1,
              minWidth: 200,
              padding: "8px 12px",
              borderRadius: 6,
              border: "1px solid var(--color-border-default)",
              background: "var(--color-surface-1)",
              color: "var(--color-t-primary)",
              fontFamily: "inherit",
              fontSize: 14,
              outline: "none",
            }}
          />
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            style={{
              padding: "8px 12px",
              borderRadius: 6,
              border: "1px solid var(--color-border-default)",
              background: "var(--color-surface-1)",
              color: "var(--color-t-primary)",
              fontFamily: "inherit",
              fontSize: 13,
            }}
          >
            <option value="all">All sources</option>
            <option value="upload">Uploads</option>
            <option value="local">Local files</option>
            <option value="warehouse">Warehouse</option>
          </select>
          <select
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value as DateFilter)}
            style={{
              padding: "8px 12px",
              borderRadius: 6,
              border: "1px solid var(--color-border-default)",
              background: "var(--color-surface-1)",
              color: "var(--color-t-primary)",
              fontFamily: "inherit",
              fontSize: 13,
            }}
          >
            <option value="all">All time</option>
            <option value="today">Today</option>
            <option value="week">This week</option>
            <option value="month">This month</option>
          </select>
        </div>

        {/* Results count */}
        {!loading && search && (
          <div style={{ fontSize: 13, color: "var(--color-t-tertiary)", marginBottom: 12 }}>
            {filtered.length} of {entries.length} results
          </div>
        )}

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: "center", padding: "60px 0", color: "var(--color-t-tertiary)" }}>
            Loading history...
          </div>
        )}

        {/* Empty state */}
        {!loading && entries.length === 0 && (
          <div style={{ textAlign: "center", padding: "80px 0" }}>
            <div style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }}>&#x1F4CA;</div>
            <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>
              No analysis history yet
            </div>
            <div style={{ fontSize: 14, color: "var(--color-t-secondary)" }}>
              Your analyses will appear here automatically.
            </div>
          </div>
        )}

        {/* History cards */}
        {!loading && filtered.length > 0 && (
          <div className="flex flex-col gap-3">
            {filtered.map((entry) => {
              const isExpanded = expandedId === entry.id;
              const isDeleting = deletingId === entry.id;

              return (
                <div
                  key={entry.id}
                  style={{
                    background: "var(--color-surface-1)",
                    border: "1px solid var(--color-border-default)",
                    borderRadius: "var(--radius-card, 8px)",
                    overflow: "hidden",
                    opacity: isDeleting ? 0.5 : 1,
                    transition: "opacity 0.2s",
                  }}
                >
                  {/* Card header — clickable */}
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                    style={{
                      width: "100%",
                      padding: "14px 18px",
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      textAlign: "left",
                      fontFamily: "inherit",
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 14,
                    }}
                  >
                    {/* Source type badge */}
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        padding: "2px 8px",
                        borderRadius: 4,
                        background: SOURCE_TYPE_COLORS[entry.sourceType] ?? "#888",
                        color: "white",
                        flexShrink: 0,
                        marginTop: 3,
                      }}
                    >
                      {SOURCE_TYPE_LABELS[entry.sourceType] ?? entry.sourceType}
                    </span>

                    {/* Question + metadata */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 14,
                          fontWeight: 500,
                          color: "var(--color-t-primary)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: isExpanded ? "normal" : "nowrap",
                        }}
                      >
                        {entry.question}
                      </div>
                      <div
                        className="flex flex-wrap items-center gap-2"
                        style={{ fontSize: 12, color: "var(--color-t-tertiary)", marginTop: 4 }}
                      >
                        <span>{entry.sourceFile}</span>
                        <span>&middot;</span>
                        <span>{entry.rowCount.toLocaleString()} rows</span>
                        <span>&middot;</span>
                        <span>{formatDuration(entry.executionMs)}</span>
                        <span>&middot;</span>
                        <span>{formatDate(entry.timestamp)}</span>
                      </div>
                    </div>

                    {/* Expand indicator */}
                    <span
                      style={{
                        fontSize: 14,
                        color: "var(--color-t-tertiary)",
                        transform: isExpanded ? "rotate(180deg)" : "none",
                        transition: "transform 0.15s",
                        flexShrink: 0,
                      }}
                    >
                      &#9660;
                    </span>
                  </button>

                  {/* Expanded details */}
                  {isExpanded && (
                    <div
                      style={{
                        borderTop: "1px solid var(--color-border-default)",
                        padding: "14px 18px",
                      }}
                    >
                      {/* Chart types */}
                      {entry.chartTypes.length > 0 && (
                        <div className="flex flex-wrap gap-1.5" style={{ marginBottom: 10 }}>
                          {entry.chartTypes.map((ct: string) => (
                            <span
                              key={ct}
                              style={{
                                fontSize: 11,
                                padding: "1px 8px",
                                borderRadius: 4,
                                background: "var(--color-accent-subtle)",
                                color: "var(--color-accent-text)",
                              }}
                            >
                              {ct}
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Analysis description */}
                      {(entry.description || entry.specSummary) && (
                        <div
                          style={{
                            fontSize: 13,
                            color: "var(--color-t-secondary)",
                            whiteSpace: "pre-wrap",
                            lineHeight: 1.6,
                            marginBottom: 12,
                            maxHeight: 200,
                            overflow: "auto",
                          }}
                        >
                          {entry.description || entry.specSummary}
                        </div>
                      )}

                      {/* Local path */}
                      {entry.localPath && (
                        <div
                          style={{
                            fontSize: 12,
                            color: "var(--color-t-tertiary)",
                            marginBottom: 10,
                          }}
                        >
                          Path: {entry.localPath}
                        </div>
                      )}

                      {/* Actions */}
                      <div className="flex items-center gap-2">
                        <a
                          href={`/?restore=${entry.id}`}
                          style={{
                            padding: "6px 14px",
                            borderRadius: 6,
                            background: "var(--color-accent)",
                            color: "white",
                            fontSize: 13,
                            fontWeight: 600,
                            textDecoration: "none",
                          }}
                        >
                          Restore
                        </a>
                        <a
                          href={`/?rerun_history=${entry.id}`}
                          title={
                            entry.sourceType === "warehouse"
                              ? "Requires an active warehouse connection"
                              : "Re-execute the analysis code with current data"
                          }
                          style={{
                            padding: "6px 14px",
                            borderRadius: 6,
                            border: "1px solid var(--color-accent)",
                            background: "transparent",
                            color: "var(--color-accent)",
                            fontSize: 13,
                            fontWeight: 600,
                            textDecoration: "none",
                          }}
                        >
                          Re-run
                        </a>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(entry.id);
                          }}
                          disabled={isDeleting}
                          style={{
                            padding: "6px 14px",
                            borderRadius: 6,
                            border: "1px solid var(--color-border-default)",
                            background: "transparent",
                            color: "var(--color-t-secondary)",
                            fontSize: 13,
                            cursor: "pointer",
                            fontFamily: "inherit",
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* No results from filter */}
        {!loading && entries.length > 0 && filtered.length === 0 && (
          <div style={{ textAlign: "center", padding: "60px 0", color: "var(--color-t-tertiary)" }}>
            No analyses match your filters.
          </div>
        )}
      </main>
    </div>
  );
}
