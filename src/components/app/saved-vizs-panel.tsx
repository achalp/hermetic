"use client";

import { useEffect, useState } from "react";
import type { SavedVizMeta } from "@/lib/types";
import { listVizs, deleteViz } from "@/lib/api";

interface SavedVizsPanelProps {
  onLoad: (vizId: string) => void;
  onRerun: (vizId: string) => void;
  refreshKey: number;
}

export function SavedVizsPanel({ onLoad, onRerun, refreshKey }: SavedVizsPanelProps) {
  const [vizs, setVizs] = useState<SavedVizMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    listVizs(controller.signal)
      .then((vizsList) => setVizs(vizsList))
      .catch(() => setVizs([]))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [refreshKey]);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteViz(id);
      setVizs((prev) => prev.filter((v) => v.vizId !== id));
    } catch {
      // ignore
    } finally {
      setDeletingId(null);
    }
  };

  if (loading) {
    return (
      <div
        className="theme-card border border-border-default bg-surface-1 p-6"
        style={{
          borderRadius: "var(--radius-card)",
          boxShadow: "var(--shadow-card)",
        }}
      >
        <p className="text-sm text-t-secondary">Loading saved visualizations...</p>
      </div>
    );
  }

  if (vizs.length === 0) {
    return (
      <div
        className="theme-card border border-border-default bg-surface-1 p-6"
        style={{
          borderRadius: "var(--radius-card)",
          boxShadow: "var(--shadow-card)",
        }}
      >
        <p className="text-sm text-t-secondary">
          No saved visualizations yet. Run a query and click &quot;Save&quot; to keep it.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {vizs.map((viz) => (
        <div
          key={viz.vizId}
          className="theme-card flex items-center justify-between gap-4 border border-border-default bg-surface-1 px-4 py-3"
          style={{
            borderRadius: "var(--radius-card)",
            boxShadow: "var(--shadow-card)",
          }}
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-t-primary">{viz.question}</p>
            <p className="mt-0.5 text-xs text-t-secondary">
              {viz.csvFilename} &middot;{" "}
              {new Date(viz.createdAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
              {(viz.versionCount ?? 1) > 1 && (
                <span className="ml-1 text-t-tertiary">&middot; {viz.versionCount} versions</span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              onClick={() => onLoad(viz.vizId)}
              className="bg-accent-subtle px-3 py-1.5 text-xs font-medium text-accent-text hover:bg-accent/10 transition-colors"
              style={{
                borderRadius: "var(--radius-badge)",
                transitionDuration: "var(--transition-speed)",
              }}
            >
              Load
            </button>
            <button
              onClick={() => onRerun(viz.vizId)}
              className="bg-accent-subtle px-3 py-1.5 text-xs font-medium text-accent-text hover:bg-accent/10 transition-colors"
              style={{
                borderRadius: "var(--radius-badge)",
                transitionDuration: "var(--transition-speed)",
              }}
            >
              Update Data
            </button>
            <button
              onClick={() => handleDelete(viz.vizId)}
              disabled={deletingId === viz.vizId}
              className="px-3 py-1.5 text-xs font-medium text-t-secondary hover:bg-surface-btn hover:text-error-text disabled:opacity-50 transition-colors"
              style={{
                borderRadius: "var(--radius-badge)",
                transitionDuration: "var(--transition-speed)",
              }}
            >
              {deletingId === viz.vizId ? "..." : "Delete"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
