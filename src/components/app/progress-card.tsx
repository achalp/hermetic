"use client";

import type { ExecState, StreamState } from "@/lib/contracts/stream-state";
import { useState, type ReactNode } from "react";
import { stopAnalysis } from "@/lib/api";

export interface ProgressStep {
  /** The one-liner for this stage (the active-tense label while it runs). */
  label: string;
  status: "done" | "active" | "upcoming";
}

function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

function pctFrom(exec: ExecState | undefined): number | null {
  if (!exec) return null;
  if (typeof exec.fraction === "number")
    return Math.max(0, Math.min(100, Math.round(exec.fraction * 100)));
  if (exec.rows && exec.total_rows) return Math.round((exec.rows / exec.total_rows) * 100);
  return null;
}

/**
 * One contained, collapsible progress card — shared by the Ask (pipeline) and
 * Investigate streams. It unifies what used to be two floating islands (a step
 * list and a separate live-exec block) into a single reading order:
 *
 *   header (current stage · elapsed · toggle)
 *     └ expanded: vertical stepper rail
 *          └ active step: live phase detail + progress bar
 *        estimate caption
 *        Stop
 *
 * Collapsed, the header alone stands in for the whole thing: the current
 * stage's status is the one-liner heading, with a slim live bar beneath.
 *
 * Reads three keys off `state`: __exec (live phase/elapsed/fraction),
 * __estimate (up-front duration caption), __runId (enables Stop).
 */
export function ProgressCard({
  steps,
  state,
  defaultExpanded = true,
  children,
}: {
  steps: ProgressStep[];
  state: StreamState | undefined;
  defaultExpanded?: boolean;
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [stopping, setStopping] = useState(false);

  const { __exec: exec, __estimate: estimate, __runId: runId } = state ?? {};

  const active = steps.find((s) => s.status === "active");
  const heading = active?.label ?? steps.find((s) => s.status !== "done")?.label ?? "Working…";
  const elapsed = exec?.elapsed_ms != null ? fmtDuration(exec.elapsed_ms) : null;
  const activePct = pctFrom(exec);
  const phaseDetail =
    exec?.detail || (exec?.phase && exec.phase !== "starting" ? exec.phase : null);

  const onStop = async () => {
    if (!runId || stopping) return;
    setStopping(true);
    await stopAnalysis(runId);
  };

  return (
    <div className="mx-auto w-full max-w-md" role="status" aria-live="polite">
      <div
        className="overflow-hidden border border-border-default bg-surface-1"
        style={{ borderRadius: "var(--radius-card)" }}
      >
        {/* Header — always visible; the current stage's status is the heading. */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-surface-2/60"
        >
          <span className="shrink-0 text-accent">
            <SpinnerIcon />
          </span>
          <span className="flex-1 truncate text-sm font-medium text-t-primary">{heading}</span>
          {elapsed && (
            <span className="shrink-0 text-xs tabular-nums text-t-tertiary">{elapsed}</span>
          )}
          <Chevron open={expanded} />
        </button>

        {/* Collapsed: a slim live bar is the only "still-running" signal we keep. */}
        {!expanded && <ProgressBar pct={activePct} rounded={false} />}

        {/* Expanded: the full stepper rail + estimate + Stop. */}
        {expanded && (
          <div className="border-t border-border-default px-4 pb-4 pt-3.5">
            <ol className="flex flex-col">
              {steps.map((step, i) => (
                <StepRow
                  key={i}
                  step={step}
                  isLast={i === steps.length - 1}
                  detail={step.status === "active" ? phaseDetail : null}
                  pct={step.status === "active" ? activePct : null}
                />
              ))}
            </ol>

            {children}

            {estimate?.detail && (
              <p className="mt-3.5 text-center text-xs leading-relaxed text-t-tertiary">
                {estimate.detail}
              </p>
            )}

            {runId && (
              <div className="mt-3.5 flex justify-center">
                <button
                  type="button"
                  onClick={onStop}
                  disabled={stopping}
                  className="bg-surface-btn px-3.5 py-1.5 text-xs font-medium text-t-btn transition-colors hover:bg-surface-btn-hover disabled:opacity-50"
                  style={{ borderRadius: "var(--radius-button)" }}
                >
                  {stopping ? "Stopping…" : "Stop analysis"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StepRow({
  step,
  isLast,
  detail,
  pct,
}: {
  step: ProgressStep;
  isLast: boolean;
  detail: string | null;
  pct: number | null;
}) {
  const labelClass =
    step.status === "active"
      ? "text-t-primary font-medium"
      : step.status === "done"
        ? "text-t-secondary"
        : "text-t-tertiary";

  return (
    <li className="flex gap-3">
      {/* Rail gutter: icon + a connector line down to the next step. */}
      <div className="flex flex-col items-center">
        <StepIcon status={step.status} />
        {!isLast && <span className="my-1 w-px flex-1 bg-border-default" />}
      </div>

      <div className={isLast ? "flex-1" : "flex-1 pb-3"}>
        <div className={`text-sm leading-5 ${labelClass}`}>{step.label}</div>
        {detail && <p className="mt-1 text-xs leading-relaxed text-t-tertiary">{detail}</p>}
        {step.status === "active" && (pct != null || detail) && (
          <div className="mt-2">
            <ProgressBar pct={pct} rounded />
          </div>
        )}
      </div>
    </li>
  );
}

function ProgressBar({ pct, rounded }: { pct: number | null; rounded: boolean }) {
  const track = `h-1 w-full overflow-hidden bg-surface-2 ${rounded ? "rounded-full" : ""}`;
  if (pct != null) {
    return (
      <div className={track}>
        <div
          className={`h-full bg-accent transition-all duration-500 ${rounded ? "rounded-full" : ""}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    );
  }
  // Unknown fraction → an indeterminate sweep so a long silent scan still reads
  // as alive.
  return (
    <div className={track}>
      <div
        className={`h-full w-1/4 bg-accent animate-indeterminate ${rounded ? "rounded-full" : ""}`}
      />
    </div>
  );
}

function StepIcon({ status }: { status: ProgressStep["status"] }) {
  if (status === "active") {
    return (
      <span className="text-accent">
        <SpinnerIcon />
      </span>
    );
  }
  if (status === "done") {
    return (
      <svg
        className="h-4 w-4 text-success-text"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  return (
    <span
      className="inline-block h-4 w-4 rounded-full border border-border-default"
      aria-hidden="true"
    />
  );
}

function SpinnerIcon() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`h-4 w-4 shrink-0 text-t-tertiary transition-transform duration-200 ${open ? "rotate-180" : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
