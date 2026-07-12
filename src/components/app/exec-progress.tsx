"use client";

import { useState } from "react";
import { stopAnalysis } from "@/lib/api";

/** The live-execution progress the server streams (see run-control SandboxProgress). */
interface ExecState {
  phase?: string;
  detail?: string;
  fraction?: number;
  rows?: number;
  total_rows?: number;
  elapsed_ms?: number;
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/**
 * Meaningful live progress + on-demand Stop, shared by the Ask and Investigate
 * streams. Renders (from /state): the up-front duration estimate (__estimate),
 * the live phase/detail/elapsed and a bar when a fraction is known (__exec), and
 * a Stop button that cancels the run by id (__runId). All optional — absent keys
 * simply don't render.
 */
export function ExecProgress({ state }: { state: Record<string, unknown> | undefined }) {
  const [stopping, setStopping] = useState(false);
  const exec = state?.__exec as ExecState | undefined;
  const estimate = state?.__estimate as { detail?: string } | undefined;
  const runId = state?.__runId as string | undefined;

  if (!exec && !estimate && !runId) return null;

  const pct =
    typeof exec?.fraction === "number"
      ? Math.max(0, Math.min(100, Math.round(exec.fraction * 100)))
      : exec?.rows && exec?.total_rows
        ? Math.round((exec.rows / exec.total_rows) * 100)
        : null;

  const elapsed = exec?.elapsed_ms != null ? fmtDuration(exec.elapsed_ms) : null;
  const detail = exec?.detail || (exec?.phase && exec.phase !== "starting" ? exec.phase : null);

  const onStop = async () => {
    if (!runId) return;
    setStopping(true);
    await stopAnalysis(runId);
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-2" role="status" aria-live="polite">
      {estimate?.detail && (
        <div className="text-center text-xs text-t-tertiary">{estimate.detail}</div>
      )}

      {detail && (
        <div className="flex items-center justify-center gap-2 text-sm text-t-secondary">
          <span>{detail}</span>
          {elapsed && <span className="text-t-tertiary">· {elapsed}</span>}
          {pct != null && <span className="text-t-tertiary">· {pct}%</span>}
        </div>
      )}

      {pct != null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-accent transition-all duration-500"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      {runId && (
        <button
          type="button"
          onClick={onStop}
          disabled={stopping}
          className="mx-auto mt-1 rounded-full border border-border-default px-3 py-1 text-xs text-t-secondary transition-colors hover:text-t-primary disabled:opacity-50"
          style={{ borderRadius: "var(--radius-button)" }}
        >
          {stopping ? "Stopping…" : "Stop analysis"}
        </button>
      )}
    </div>
  );
}
