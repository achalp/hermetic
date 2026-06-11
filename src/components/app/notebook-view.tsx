"use client";

/**
 * Notebook view for Investigate results.
 *
 * Renders each investigation step as a notebook cell: question/status
 * header → composed output (the step's `cellSpec` mini-spec) → collapsible
 * code → collapsible data preview. Cells appear in pending state the moment
 * the plan lands and fill in live as each step's cell compose streams in —
 * the notebook writes itself while the investigation runs.
 *
 * Data sources, in priority order:
 *   - `spec.state.__plan`  — step skeleton + live status (streamed)
 *   - `spec.state.__cells` — per-step composed mini-specs (streamed; also
 *     present in specs reloaded from history, since state persists)
 *   - `artifacts.investigation` — the audit trail; enriches cells with
 *     code, datasets, provenance, and timing once artifacts are loaded.
 */

import { useState, type ReactNode } from "react";
import { Renderer, StateProvider, ActionProvider, VisibilityProvider } from "@json-render/react";
import type { Spec } from "@json-render/react";
import { registry } from "@/components/registry";
import { RendererErrorBoundary } from "@/components/app/renderer-error-boundary";
import { CodeEditor } from "@/components/app/code-editor";
import { MiniTable, recordsToTable } from "@/components/app/artifacts-viewer";
import type { CachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import type { TraceStep } from "@/lib/pipeline/investigation-trace";

type CellStatus = "pending" | "running" | "done" | "degraded" | "failed" | "removed";

interface NotebookCellModel {
  index: number;
  stepNo: number;
  question: string;
  rationale?: string;
  status: CellStatus;
  degradedReason?: string;
  error?: string;
  cellSpec?: Spec;
  /** Audit-trail step, once artifacts are loaded — code, datasets, timing. */
  trace?: TraceStep;
  /** Provenance when known: who added the step beyond the initial plan. */
  source?: "replanner" | "composer";
}

interface PlanStepState {
  index: number;
  question: string;
  rationale?: string;
  status?: string;
  degradedReason?: string;
  error?: string;
  addedByReplanner?: boolean;
  addedByComposer?: boolean;
}

interface CellState {
  status?: string;
  cellSpec?: Spec;
}

function normalizeStatus(raw: string | undefined): CellStatus {
  switch (raw) {
    case "running":
      return "running";
    case "done":
    case "success":
      return "done";
    case "degraded":
      return "degraded";
    case "failed":
      return "failed";
    case "removed":
      return "removed";
    default:
      return "pending";
  }
}

/** Build the cell list from spec state (live or reloaded) + trail (loaded). */
export function buildNotebookCells(
  spec: Spec | null,
  artifacts: CachedArtifacts | null | undefined
): NotebookCellModel[] {
  const state = (spec?.state as Record<string, unknown> | undefined) ?? {};
  const plan = state.__plan as { steps?: PlanStepState[] } | undefined;
  const cellsState = (state.__cells as Record<string, CellState> | undefined) ?? {};
  const trace = artifacts?.investigation;
  const traceByIndex = new Map<number, TraceStep>(trace?.steps.map((s) => [s.index, s]) ?? []);

  if (plan?.steps && plan.steps.length > 0) {
    return plan.steps.map((ps) => {
      const t = traceByIndex.get(ps.index);
      const cell = cellsState[String(ps.index)];
      return {
        index: ps.index,
        stepNo: ps.index + 1,
        question: ps.question,
        rationale: ps.rationale,
        status: normalizeStatus(t?.status ?? ps.status),
        degradedReason: ps.degradedReason ?? t?.degradedReason,
        error: ps.error ?? t?.error,
        cellSpec: cell?.cellSpec ?? t?.cellSpec,
        trace: t,
        source:
          t?.source && t.source !== "initial"
            ? t.source
            : ps.addedByComposer
              ? "composer"
              : ps.addedByReplanner
                ? "replanner"
                : undefined,
      };
    });
  }

  // No plan in state (e.g. artifacts-only consumers): build from the trail.
  if (trace) {
    return trace.steps.map((t) => ({
      index: t.index,
      stepNo: t.stepNo,
      question: t.question,
      rationale: t.rationale,
      status: normalizeStatus(t.status),
      degradedReason: t.degradedReason,
      error: t.error,
      cellSpec: t.cellSpec,
      trace: t,
      source: t.source !== "initial" ? t.source : undefined,
    }));
  }

  return [];
}

const STATUS_CHIP: Record<CellStatus, { label: string; className: string }> = {
  pending: { label: "pending", className: "text-t-tertiary border-border-default" },
  running: { label: "running", className: "text-accent border-accent" },
  done: { label: "done", className: "text-success-text border-success-border" },
  degraded: { label: "degraded", className: "text-warning-text border-warning-border" },
  failed: { label: "failed", className: "text-error-text border-error-border" },
  removed: { label: "dropped", className: "text-t-tertiary border-border-default" },
};

function Chip({ label, className }: { label: string; className: string }) {
  return (
    <span
      className={`border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${className}`}
      style={{ borderRadius: "var(--radius-badge)" }}
    >
      {label}
    </span>
  );
}

function Disclosure({
  label,
  children,
  defaultOpen = false,
}: {
  label: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-table-divider pt-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs font-medium text-t-secondary hover:text-t-primary"
      >
        <span className="text-[10px]">{open ? "▼" : "▶"}</span>
        {label}
      </button>
      {open && <div className="mt-2 flex flex-col gap-3">{children}</div>}
    </div>
  );
}

function CellOutput({ cellSpec }: { cellSpec: Spec }) {
  return (
    <StateProvider initialState={cellSpec.state ?? {}}>
      <ActionProvider>
        <VisibilityProvider>
          <RendererErrorBoundary>
            <Renderer spec={cellSpec} registry={registry} />
          </RendererErrorBoundary>
        </VisibilityProvider>
      </ActionProvider>
    </StateProvider>
  );
}

function NotebookCell({ cell, isStreaming }: { cell: NotebookCellModel; isStreaming: boolean }) {
  if (cell.status === "removed") {
    return (
      <div
        className="border border-border-default px-4 py-2 text-sm text-t-tertiary"
        style={{ borderRadius: "var(--radius-card)" }}
      >
        <span className="font-medium">Step {cell.stepNo}</span> — dropped by the re-planner:{" "}
        {cell.question}
      </div>
    );
  }

  const chip = STATUS_CHIP[cell.status];
  const datasets = cell.trace?.datasets ?? {};
  const datasetEntries = Object.entries(datasets).filter(
    ([, rows]) => Array.isArray(rows) && rows.length > 0
  );

  return (
    <div
      className="theme-card border border-border-default bg-surface-1"
      style={{ borderRadius: "var(--radius-card)", boxShadow: "var(--shadow-card)" }}
    >
      {/* Header */}
      <div className="flex flex-col gap-1 border-b border-table-divider px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="bg-accent-subtle px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent"
            style={{ borderRadius: "var(--radius-badge)" }}
          >
            Step {cell.stepNo}
          </span>
          <Chip label={chip.label} className={chip.className} />
          {cell.source && (
            <Chip
              label={cell.source === "composer" ? "added by composer" : "added by re-planner"}
              className="text-t-tertiary border-border-default"
            />
          )}
          {cell.trace?.execution_ms !== undefined && cell.trace.execution_ms > 0 && (
            <span className="ml-auto text-xs text-t-tertiary">
              {(cell.trace.execution_ms / 1000).toFixed(1)}s
            </span>
          )}
        </div>
        <h3 className="text-sm font-medium text-t-primary">{cell.question}</h3>
        {cell.rationale && <p className="text-xs text-t-tertiary">{cell.rationale}</p>}
      </div>

      {/* Body */}
      <div className="flex flex-col gap-3 px-4 py-3">
        {cell.status === "failed" ? (
          <div
            className="border border-error-border bg-error-bg px-3 py-2 text-sm text-error-text"
            style={{ borderRadius: "var(--radius-badge)" }}
          >
            Step failed{cell.error ? `: ${cell.error}` : "."}
          </div>
        ) : cell.cellSpec ? (
          <>
            {cell.status === "degraded" && cell.degradedReason && (
              <div
                className="border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-text"
                style={{ borderRadius: "var(--radius-badge)" }}
              >
                Validator flagged this result: {cell.degradedReason}
              </div>
            )}
            <CellOutput cellSpec={cell.cellSpec} />
          </>
        ) : cell.status === "pending" || cell.status === "running" ? (
          <div className="flex items-center gap-2 py-4 text-sm text-t-tertiary">
            <span
              className={
                cell.status === "running" ? "h-2 w-2 animate-pulse rounded-full bg-accent" : ""
              }
            />
            {cell.status === "running" ? "Running analysis…" : "Waiting for upstream steps…"}
          </div>
        ) : isStreaming ? (
          <div className="flex items-center gap-2 py-4 text-sm text-t-tertiary">
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
            Composing cell…
          </div>
        ) : (
          <p className="py-2 text-sm text-t-tertiary">
            No cell visualization for this step — its code and data are in the artifacts Trail.
          </p>
        )}

        {/* Code disclosure — available once the audit trail is loaded */}
        {cell.trace?.code && (
          <Disclosure label="Code">
            <div className="overflow-hidden" style={{ borderRadius: "var(--radius-badge)" }}>
              <CodeEditor value={cell.trace.code} language="python" readOnly height={260} />
            </div>
          </Disclosure>
        )}

        {/* Data disclosure */}
        {datasetEntries.length > 0 && (
          <Disclosure
            label={`Data (${datasetEntries.reduce((n, [, rows]) => n + rows.length, 0)} rows)`}
          >
            {datasetEntries.map(([name, rows]) => {
              const { columns, rows: tableRows } = recordsToTable(rows);
              return (
                <div key={name}>
                  <p className="mb-1 text-xs font-medium text-t-secondary">{name}</p>
                  <MiniTable columns={columns} rows={tableRows} maxRows={25} />
                </div>
              );
            })}
          </Disclosure>
        )}
      </div>
    </div>
  );
}

export function NotebookView({
  spec,
  artifacts,
  isStreaming,
}: {
  spec: Spec | null;
  artifacts?: CachedArtifacts | null;
  isStreaming: boolean;
}) {
  const cells = buildNotebookCells(spec, artifacts);
  const state = (spec?.state as Record<string, unknown> | undefined) ?? {};
  const plan = state.__plan as { approach?: string } | undefined;
  const approach = plan?.approach ?? artifacts?.investigation?.approach;

  if (cells.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-t-tertiary" role="status">
        {isStreaming ? "Planning the investigation…" : "No investigation steps to show."}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3" data-testid="notebook-view">
      {approach && (
        <p className="px-1 text-xs text-t-tertiary">
          <span className="font-medium text-t-secondary">Approach:</span> {approach}
        </p>
      )}
      {cells.map((cell) => (
        <NotebookCell key={cell.index} cell={cell} isStreaming={isStreaming} />
      ))}
    </div>
  );
}
