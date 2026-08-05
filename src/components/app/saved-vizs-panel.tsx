"use client";

import { useEffect, useState, useCallback } from "react";
import type { SavedVizMeta } from "@/lib/contracts/storage-types";
import { listVizs, deleteViz, listSchedules, type ScheduleEntry } from "@/app/lib/api";
import { SchedulePopover, SchedulePill } from "./schedule-popover";

interface SavedVizsPanelProps {
  onLoad: (vizId: string) => void;
  onRerun: (vizId: string) => void;
  onRefresh: (vizId: string) => void;
  refreshKey: number;
}

export function SavedVizsPanel({ onLoad, onRerun, onRefresh, refreshKey }: SavedVizsPanelProps) {
  const [vizs, setVizs] = useState<SavedVizMeta[]>([]);
  const [schedules, setSchedules] = useState<ScheduleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Schedule popover state — keyed on vizId. When open, anchors to the
  // pill or button that triggered it.
  const [scheduleAnchor, setScheduleAnchor] = useState<{ vizId: string; rect: DOMRect } | null>(
    null
  );

  const refreshAll = useCallback((signal?: AbortSignal) => {
    setLoading(true);
    Promise.all([listVizs(signal).catch(() => []), listSchedules(signal).catch(() => [])])
      .then(([vizsList, schedList]) => {
        setVizs(vizsList);
        setSchedules(schedList);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refreshAll(controller.signal);
    return () => controller.abort();
  }, [refreshKey, refreshAll]);

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await deleteViz(id);
      setVizs((prev) => prev.filter((v) => v.vizId !== id));
      // Stale schedule entries pointing at the deleted viz remain in
      // schedules.json; the scheduler skips them at runtime. Clearing them
      // here keeps the UI consistent.
      setSchedules((prev) => prev.filter((s) => s.vizId !== id));
    } catch {
      // ignore
    } finally {
      setDeletingId(null);
    }
  };

  // Index schedules by vizId for O(1) lookup
  const scheduleByViz = new Map(schedules.map((s) => [s.vizId, s]));

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
    <>
      <div className="space-y-2">
        {vizs.map((viz) => {
          const sched = scheduleByViz.get(viz.vizId) ?? null;
          return (
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
                    <span className="ml-1 text-t-tertiary">
                      &middot; {viz.versionCount} versions
                    </span>
                  )}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {/* Pill sits at the start of the actions cluster so it
                    vertically centers with the buttons. Same click target
                    as the Edit-schedule button. */}
                <SchedulePill
                  schedule={sched}
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setScheduleAnchor({ vizId: viz.vizId, rect });
                  }}
                />
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
                  onClick={() => onRefresh(viz.vizId)}
                  className="bg-accent-subtle px-3 py-1.5 text-xs font-medium text-accent-text hover:bg-accent/10 transition-colors"
                  style={{
                    borderRadius: "var(--radius-badge)",
                    transitionDuration: "var(--transition-speed)",
                  }}
                >
                  Re-run
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
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setScheduleAnchor({ vizId: viz.vizId, rect });
                  }}
                  className="bg-accent-subtle px-3 py-1.5 text-xs font-medium text-accent-text hover:bg-accent/10 transition-colors"
                  style={{
                    borderRadius: "var(--radius-badge)",
                    transitionDuration: "var(--transition-speed)",
                  }}
                  title={sched ? "Edit schedule" : "Schedule re-runs"}
                >
                  {sched ? "Edit schedule" : "Schedule"}
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
          );
        })}
      </div>
      {scheduleAnchor && (
        <SchedulePopover
          vizId={scheduleAnchor.vizId}
          anchorRect={scheduleAnchor.rect}
          onClose={() => setScheduleAnchor(null)}
          onChanged={() => refreshAll()}
        />
      )}
    </>
  );
}
