"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  setSchedule,
  deleteSchedule,
  runScheduleNow,
  listSchedules,
  ApiError,
  type ScheduleEntry,
  type ScheduleCadence,
} from "@/app/lib/api";
import { relativeTime } from "@/lib/format";

const CADENCE_LABELS: Record<ScheduleCadence, string> = {
  hourly: "Every hour",
  "daily-9am": "Daily at 9 AM",
  "daily-eod": "Daily at 6 PM",
  "weekly-monday": "Weekly (Monday 9 AM)",
  "on-file-change": "On file change",
};

const CADENCE_ORDER: ScheduleCadence[] = [
  "hourly",
  "daily-9am",
  "daily-eod",
  "weekly-monday",
  "on-file-change",
];

interface SchedulePopoverProps {
  vizId: string;
  /** Anchor element to position the popover against (right-aligned by default). */
  anchorRect: DOMRect | null;
  onClose: () => void;
  /** Called after any schedule mutation (set / delete / run-now) so the parent can refresh state. */
  onChanged?: () => void;
}

function formatRelative(ms: number | null): string {
  if (!ms) return "never";
  return relativeTime(ms);
}

/**
 * Self-contained popover that renders next to its anchor. Used by both the
 * dashboard toolbar Schedule button and the per-row schedule indicator in
 * the Saved Vizs panel. Loads the existing schedule (if any) on mount and
 * shows cadence dropdown, auto-export checkboxes, Run now, and Delete.
 */
export function SchedulePopover({ vizId, anchorRect, onClose, onChanged }: SchedulePopoverProps) {
  const [existing, setExisting] = useState<ScheduleEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [cadence, setCadence] = useState<ScheduleCadence>("daily-9am");
  const [exports, setExports] = useState<Set<"xlsx" | "csv">>(new Set(["xlsx"]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  // Load existing schedule for this viz
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listSchedules()
      .then((all) => {
        if (cancelled) return;
        const found = all.find((s) => s.vizId === vizId) ?? null;
        setExisting(found);
        if (found) {
          setCadence(found.cadence);
          setExports(new Set(found.autoExport));
        }
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't load existing schedule.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [vizId]);

  // Close on outside click and Escape
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) onClose();
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [onClose]);

  const handleSaveSchedule = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const entry = await setSchedule(vizId, cadence, [...exports]);
      setExisting(entry);
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [vizId, cadence, exports, onChanged]);

  const handleDelete = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteSchedule(vizId);
      setExisting(null);
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [vizId, onChanged]);

  const handleRunNow = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await runScheduleNow(vizId);
      if (!result.ok) {
        setError(result.error ?? "Run failed");
      } else {
        // Reload to reflect lastRunAt
        const all = await listSchedules();
        setExisting(all.find((s) => s.vizId === vizId) ?? null);
        onChanged?.();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [vizId, onChanged]);

  // Position: right-anchored to anchorRect, opens DOWN
  const top = anchorRect ? anchorRect.bottom + 8 : 80;
  const right = anchorRect ? Math.max(8, window.innerWidth - anchorRect.right) : 16;

  return (
    <div
      ref={popoverRef}
      className="theme-card border border-border-default bg-surface-1"
      style={{
        position: "fixed",
        top,
        right,
        zIndex: "var(--z-export-dropdown)",
        width: 340,
        padding: 16,
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-elevated)",
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm font-semibold text-t-primary">
          {existing ? "Edit schedule" : "Schedule re-run"}
        </p>
        <button
          onClick={onClose}
          className="text-t-tertiary hover:text-t-primary"
          aria-label="Close"
          style={{ fontSize: 18, lineHeight: 1, padding: 2 }}
        >
          ×
        </button>
      </div>

      {loading ? (
        <p className="text-xs text-t-tertiary">Loading…</p>
      ) : (
        <>
          <p className="text-xs text-t-tertiary mb-3" style={{ lineHeight: 1.5 }}>
            Re-runs the saved analysis on a cadence. Auto-exports are written to{" "}
            <code style={{ fontSize: 11 }}>~/.hermetic/scheduled-runs/&lt;vizId&gt;/</code>.
          </p>

          <label className="block text-xs font-medium text-t-secondary mb-1">Cadence</label>
          <select
            value={cadence}
            onChange={(e) => setCadence(e.target.value as ScheduleCadence)}
            disabled={busy}
            className="w-full mb-3 px-2 py-1.5 text-sm rounded border border-border-default bg-surface-input text-t-primary outline-none focus:border-accent"
          >
            {CADENCE_ORDER.map((c) => (
              <option key={c} value={c}>
                {CADENCE_LABELS[c]}
              </option>
            ))}
          </select>

          <label className="block text-xs font-medium text-t-secondary mb-1">Auto-export</label>
          <div className="flex items-center gap-3 mb-3">
            {(["xlsx", "csv"] as const).map((fmt) => (
              <label
                key={fmt}
                className="flex items-center gap-1 text-sm text-t-primary cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={exports.has(fmt)}
                  onChange={(e) => {
                    const next = new Set(exports);
                    if (e.target.checked) next.add(fmt);
                    else next.delete(fmt);
                    setExports(next);
                  }}
                  disabled={busy}
                  className="accent-accent"
                />
                {fmt.toUpperCase()}
              </label>
            ))}
          </div>

          {existing && (
            <div className="text-xs text-t-tertiary mb-3" style={{ lineHeight: 1.5 }}>
              {existing.lastStatus === "success" && (
                <span style={{ color: "var(--color-success-text)" }}>
                  ✓ Last run {formatRelative(existing.lastRunAt)}
                </span>
              )}
              {existing.lastStatus === "error" && (
                <span style={{ color: "var(--color-error-text)" }}>
                  ⚠ Last run failed: {existing.lastError ?? "unknown"}
                </span>
              )}
              {!existing.lastStatus && <span>Never run yet</span>}
              {existing.cadence !== "on-file-change" && existing.nextRunAt && (
                <>
                  {" · "}
                  <span>Next run {formatRelative(existing.nextRunAt)}</span>
                </>
              )}
            </div>
          )}

          {error && (
            <p className="text-xs mb-3" style={{ color: "var(--color-error-text)" }}>
              {error}
            </p>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={handleSaveSchedule}
              disabled={busy}
              className="bg-accent text-white px-3 py-1.5 text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
              style={{ borderRadius: "var(--radius-badge)" }}
            >
              {existing ? "Update" : "Save"}
            </button>
            {existing && (
              <button
                onClick={handleRunNow}
                disabled={busy}
                className="bg-surface-btn px-3 py-1.5 text-xs font-medium text-t-btn hover:bg-surface-btn-hover transition-colors disabled:opacity-50"
                style={{ borderRadius: "var(--radius-badge)" }}
              >
                Run now
              </button>
            )}
            {existing && (
              <button
                onClick={handleDelete}
                disabled={busy}
                className="ml-auto text-xs text-t-tertiary hover:text-error-text disabled:opacity-50"
              >
                Delete schedule
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Pill that shows current cadence; click to open the popover. */
export function SchedulePill({
  schedule,
  onClick,
}: {
  schedule: ScheduleEntry | null;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  if (!schedule) return null;
  const cadenceShort: Record<ScheduleCadence, string> = {
    hourly: "Hourly",
    "daily-9am": "Daily 9am",
    "daily-eod": "Daily 6pm",
    "weekly-monday": "Weekly Mon",
    "on-file-change": "On file change",
  };
  const failing = schedule.lastStatus === "error";
  return (
    <button
      onClick={onClick}
      className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap transition-opacity hover:opacity-80"
      style={{
        fontSize: 11,
        lineHeight: 1.4,
        padding: "2px 8px",
        borderRadius: 99,
        background: failing ? "var(--color-error-bg)" : "var(--color-success-bg)",
        color: failing ? "var(--color-error-text)" : "var(--color-success-text)",
        border: "none",
        cursor: "pointer",
      }}
      title={
        failing
          ? `Last run failed: ${schedule.lastError ?? "unknown"}`
          : `Scheduled — click to edit`
      }
    >
      {failing ? "⚠" : "📅"} {cadenceShort[schedule.cadence]}
    </button>
  );
}
