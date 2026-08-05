"use client";

import type { ActiveRun } from "@/app/lib/api";

/** "12m" / "45s" elapsed since a run started. */
export function elapsedLabel(startedAt: number, now: number): string {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m`;
}

/**
 * Surfaces analyses still running server-side after this tab lost their live
 * view (reload / HMR). Each offers a one-click Resume that reattaches to the
 * live stream (replays what happened, then streams to completion). Hidden when
 * there's nothing running. Only shown in the pre-analysis (empty) state.
 */
export function ActiveRunsBanner({
  runs,
  now = Date.now(),
  onResume,
  onDismiss,
}: {
  runs: ActiveRun[];
  now?: number;
  onResume: (run: ActiveRun) => void;
  onDismiss: (runId: string) => void;
}) {
  const resumable = runs.filter((r) => r.csvId); // needs a source to restore
  if (resumable.length === 0) return null;

  return (
    <div className="w-full" style={{ maxWidth: 700 }}>
      <div
        style={{
          border: "1px solid var(--color-accent)",
          background: "var(--color-accent-subtle)",
          borderRadius: "var(--radius-card)",
          overflow: "hidden",
        }}
      >
        {resumable.map((run, i) => (
          <div
            key={run.runId}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "12px 14px",
              borderTop: i === 0 ? "none" : "1px solid var(--color-border-default)",
            }}
          >
            <span className="shrink-0 text-accent" aria-hidden>
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  color: "var(--color-t-primary)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {run.question || "Analysis"}
              </div>
              <div style={{ fontSize: 11.5, color: "var(--color-t-secondary)" }}>
                Still running · {elapsedLabel(run.startedAt, now)} elapsed
              </div>
            </div>
            <button
              onClick={() => onResume(run)}
              className="bg-surface-btn text-t-btn transition-colors hover:bg-surface-btn-hover"
              style={{
                flexShrink: 0,
                padding: "5px 14px",
                borderRadius: "var(--radius-button)",
                border: "none",
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Resume
            </button>
            <button
              onClick={() => onDismiss(run.runId)}
              aria-label="Dismiss"
              title="Dismiss"
              className="text-t-tertiary transition-colors hover:text-t-primary"
              style={{
                flexShrink: 0,
                width: 24,
                height: 24,
                border: "none",
                background: "transparent",
                cursor: "pointer",
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
