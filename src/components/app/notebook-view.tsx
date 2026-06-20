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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Renderer, StateProvider, ActionProvider, VisibilityProvider } from "@json-render/react";
import type { Spec } from "@json-render/react";
import { registry } from "@/components/registry";
import { renderWithCitations } from "@/components/registry-primitives";
import { RendererErrorBoundary } from "@/components/app/renderer-error-boundary";
import { CodeEditor } from "@/components/app/code-editor";
import { Markdown } from "@/components/app/markdown";
import { MiniTable, recordsToTable } from "@/components/app/artifacts-viewer";
import { buildNotebookMarkdown, buildNotebookHtml } from "@/lib/notebook-export";
import { downloadAsSlides } from "@/lib/slides-export";
import { downloadCodeAsFile, downloadDashboardAsPdf, sanitizeFilename } from "@/lib/export-utils";
import { rerunInvestigateStep, saveNotebookLayout } from "@/lib/api";
import type { CachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import type {
  TraceStep,
  TraceDecision,
  NotebookLayoutCell,
} from "@/lib/pipeline/investigation-trace";

type CellStatus = "pending" | "running" | "done" | "degraded" | "failed" | "removed";

/**
 * Notebook export handlers surfaced to the page-level Export menu. Present
 * (non-null) only when the notebook view is active and its trail is ready,
 * so the menu can show notebook-native formats (Markdown / HTML / PDF) in
 * place of the dashboard formats.
 */
export interface NotebookExportApi {
  markdown: () => void;
  html: () => Promise<void>;
  pdf: () => Promise<void>;
  slides: () => Promise<void>;
}

export interface NotebookCellModel {
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

function NotebookCell({
  cell,
  isStreaming,
  highlighted = false,
  stale = false,
  rerunning = false,
  rerunError,
  onRerun,
}: {
  cell: NotebookCellModel;
  isStreaming: boolean;
  highlighted?: boolean;
  /** An upstream step was re-run with edits — this cell's results may be stale. */
  stale?: boolean;
  rerunning?: boolean;
  rerunError?: string;
  /** When provided, the cell's code is editable and re-runnable. */
  onRerun?: (index: number, code?: string) => void;
}) {
  // Per-cell editor state: null = pristine. Resets when fresh trace code
  // arrives (derived-state pattern, mirrors artifacts-viewer).
  const [editedCode, setEditedCode] = useState<string | null>(null);
  const [prevCode, setPrevCode] = useState(cell.trace?.code);
  if (cell.trace?.code !== prevCode) {
    setPrevCode(cell.trace?.code);
    setEditedCode(null);
  }
  const codeValue = editedCode ?? cell.trace?.code ?? "";
  const dirty = editedCode !== null && editedCode !== cell.trace?.code;

  if (cell.status === "removed") {
    return (
      <div
        id={`notebook-cell-${cell.stepNo}`}
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
      id={`notebook-cell-${cell.stepNo}`}
      className={`theme-card border bg-surface-1 transition-colors ${
        highlighted ? "border-accent" : "border-border-default"
      }`}
      style={{
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-card)",
        transitionDuration: "var(--transition-speed)",
      }}
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
        {stale && (
          <div
            className="flex items-center justify-between gap-2 border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-text"
            style={{ borderRadius: "var(--radius-badge)" }}
          >
            <span>An upstream step was re-run — these results may be stale.</span>
            {onRerun && (
              <button
                onClick={() => onRerun(cell.index)}
                disabled={rerunning}
                className="shrink-0 font-medium underline hover:no-underline disabled:opacity-50"
              >
                {rerunning ? "Re-running…" : "Re-run"}
              </button>
            )}
          </div>
        )}
        {rerunError && (
          <div
            className="border border-error-border bg-error-bg px-3 py-2 text-xs text-error-text"
            style={{ borderRadius: "var(--radius-badge)" }}
          >
            Re-run failed: {rerunError}
          </div>
        )}
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
            {/* data-cell-output: snapshot target for HTML/PDF export. */}
            <div data-cell-output={cell.stepNo}>
              <CellOutput cellSpec={cell.cellSpec} />
            </div>
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

        {/* SQL disclosure — per-step warehouse query (Investigate over a
            warehouse, where each step issues its own SQL). Read-only. */}
        {cell.trace?.sql && (
          <Disclosure label="SQL">
            <div className="overflow-hidden" style={{ borderRadius: "var(--radius-badge)" }}>
              <CodeEditor value={cell.trace.sql} language="sql" readOnly height={200} />
            </div>
          </Disclosure>
        )}

        {/* Code disclosure — available once the audit trail is loaded.
            Editable + re-runnable when an onRerun handler is wired up. */}
        {cell.trace?.code && (
          <Disclosure label="Code">
            <div className="overflow-hidden" style={{ borderRadius: "var(--radius-badge)" }}>
              <CodeEditor
                value={codeValue}
                language="python"
                readOnly={!onRerun}
                onChange={onRerun ? setEditedCode : undefined}
                height={260}
              />
            </div>
            {onRerun && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onRerun(cell.index, dirty ? codeValue : undefined)}
                  disabled={rerunning}
                  className="bg-surface-btn px-2.5 py-1 text-xs font-medium text-t-btn hover:bg-surface-btn-hover transition-colors disabled:opacity-50"
                  style={{
                    borderRadius: "var(--radius-badge)",
                    transitionDuration: "var(--transition-speed)",
                  }}
                >
                  {rerunning ? "Re-running…" : dirty ? "Re-run with edits" : "Re-run step"}
                </button>
                {dirty && (
                  <button
                    onClick={() => setEditedCode(null)}
                    className="text-xs text-t-secondary underline hover:no-underline"
                  >
                    Discard edits
                  </button>
                )}
              </div>
            )}
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

interface SynthesisState {
  summary?: string;
  conclusion?: string;
}

interface GroundingLike {
  ok?: boolean;
  checkedCount?: number;
  ungrounded?: string[];
}

function decisionLabel(d: TraceDecision): string {
  if (d.kind === "composer_dispatch") return "Composer dispatch";
  return `Re-planner: ${d.action ?? "decision"}`;
}

/**
 * The synthesis cell — the cross-step narrative at the bottom of the
 * notebook: executive summary + conclusion (with clickable citations), the
 * grounding verdict, and the agent's decision log.
 */
function SynthesisCell({
  synthesis,
  grounding,
  decisions,
}: {
  synthesis: SynthesisState;
  grounding?: GroundingLike;
  decisions?: TraceDecision[];
}) {
  return (
    <div
      id="notebook-cell-synthesis"
      className="theme-card border border-accent bg-surface-1"
      style={{ borderRadius: "var(--radius-card)", boxShadow: "var(--shadow-card)" }}
    >
      <div className="border-b border-table-divider px-4 py-3">
        <span
          className="bg-accent-subtle px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent"
          style={{ borderRadius: "var(--radius-badge)" }}
        >
          Synthesis
        </span>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3">
        {synthesis.summary && (
          <div className="insight-block border-l-4 border-accent pl-4 text-sm text-accent-text">
            <p className="whitespace-pre-wrap">{renderWithCitations(synthesis.summary)}</p>
          </div>
        )}
        {synthesis.conclusion && (
          <p className="whitespace-pre-wrap text-sm text-t-secondary">
            {renderWithCitations(synthesis.conclusion)}
          </p>
        )}
        {grounding && typeof grounding.ok === "boolean" && (
          <p className="text-xs">
            {grounding.ok ? (
              <span className="text-success-text">
                ✓ {grounding.checkedCount ?? 0} checked figure
                {(grounding.checkedCount ?? 0) === 1 ? "" : "s"} in the narrative matched computed
                results.
              </span>
            ) : (
              <span className="text-warning-text">
                ▲ {grounding.ungrounded?.length ?? 0} figure
                {(grounding.ungrounded?.length ?? 0) === 1 ? "" : "s"} could not be traced to a
                computed result: {grounding.ungrounded?.join(", ")}. Verify before relying on them.
              </span>
            )}
          </p>
        )}
        {decisions && decisions.length > 0 && (
          <Disclosure label="How the agent got here">
            <ol className="flex flex-col gap-2 text-xs text-t-secondary">
              {decisions.map((d, i) => (
                <li key={i}>
                  <span className="font-medium text-t-primary">{decisionLabel(d)}</span>
                  {d.rationale ? ` — ${d.rationale}` : ""}
                  {d.addedIndices.length > 0 && (
                    <span className="text-t-tertiary">
                      {" "}
                      (added {d.addedIndices.map((x) => `Step ${x + 1}`).join(", ")})
                    </span>
                  )}
                  {d.removedIndices.length > 0 && (
                    <span className="text-t-tertiary">
                      {" "}
                      (dropped {d.removedIndices.map((x) => `Step ${x + 1}`).join(", ")})
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </Disclosure>
        )}
      </div>
    </div>
  );
}

/** A user-authored markdown cell: rendered prose with an inline editor. */
function MarkdownCell({
  content,
  editable,
  onChange,
  onDelete,
}: {
  content: string;
  editable: boolean;
  onChange: (next: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(content.trim() === "");
  return (
    <div
      className="border border-dashed border-border-default bg-surface-1 px-4 py-3"
      style={{ borderRadius: "var(--radius-card)" }}
    >
      {editing && editable ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={content}
            autoFocus
            onChange={(e) => onChange(e.target.value)}
            placeholder="Write notes in markdown — # headings, **bold**, - lists…"
            className="min-h-[80px] w-full resize-y bg-surface-2 px-3 py-2 text-sm text-t-primary outline-none"
            style={{ borderRadius: "var(--radius-badge)" }}
          />
          <div className="flex items-center gap-3 text-xs">
            <button onClick={() => setEditing(false)} className="font-medium text-accent">
              Done
            </button>
            <button onClick={onDelete} className="text-error-text hover:underline">
              Delete
            </button>
          </div>
        </div>
      ) : (
        <div
          className={editable ? "group relative cursor-text" : ""}
          onClick={editable ? () => setEditing(true) : undefined}
        >
          {content.trim() ? (
            <Markdown content={content} />
          ) : (
            <p className="text-sm text-t-tertiary">Empty note — click to edit.</p>
          )}
          {editable && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }}
              className="absolute right-0 top-0 hidden text-xs text-t-tertiary hover:text-error-text group-hover:block"
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Wraps a cell with reorder/insert controls (shown only when editable). */
function CellControls({
  onMoveUp,
  onMoveDown,
  onAddMarkdown,
}: {
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onAddMarkdown: () => void;
}) {
  return (
    <div className="flex items-center justify-center gap-3 py-0.5 text-xs text-t-tertiary opacity-0 transition-opacity hover:opacity-100">
      <button
        onClick={onMoveUp}
        disabled={!onMoveUp}
        className="disabled:opacity-30"
        title="Move up"
      >
        ↑
      </button>
      <button
        onClick={onMoveDown}
        disabled={!onMoveDown}
        className="disabled:opacity-30"
        title="Move down"
      >
        ↓
      </button>
      <button onClick={onAddMarkdown} className="hover:text-accent" title="Add a text cell below">
        + Text
      </button>
    </div>
  );
}

type RenderEntry =
  | { kind: "step"; cell: NotebookCellModel }
  | { kind: "markdown"; id: string; content: string };

/** Merge the saved layout with the live step cells: layout drives order and
 *  injects markdown; step cells missing from the layout (new ones) append. */
export function orderedEntries(
  layout: NotebookLayoutCell[] | null,
  stepCells: NotebookCellModel[]
): RenderEntry[] {
  const byNo = new Map(stepCells.map((c) => [c.stepNo, c]));
  const used = new Set<number>();
  const out: RenderEntry[] = [];
  if (layout) {
    for (const lc of layout) {
      if (lc.kind === "markdown") {
        out.push({ kind: "markdown", id: lc.id, content: lc.content });
      } else if (!used.has(lc.stepNo)) {
        const c = byNo.get(lc.stepNo);
        if (c) {
          out.push({ kind: "step", cell: c });
          used.add(lc.stepNo);
        }
      }
    }
  }
  for (const c of stepCells) {
    if (!used.has(c.stepNo)) out.push({ kind: "step", cell: c });
  }
  return out;
}

export function NotebookView({
  spec,
  artifacts,
  isStreaming,
  scrollTarget,
  csvId,
  sandboxRuntime,
  onStepRerun,
  onExportApiChange,
}: {
  spec: Spec | null;
  artifacts?: CachedArtifacts | null;
  isStreaming: boolean;
  /** Citation click-through target. `seq` distinguishes repeat clicks. */
  scrollTarget?: { stepNo: number; seq: number } | null;
  /** Enables per-cell edit-and-rerun when set (and not streaming). */
  csvId?: string | null;
  sandboxRuntime?: string;
  /** Notifies the parent after a successful step re-run (e.g. to merge the
   *  fresh step into its artifacts copy and flag the dashboard stale). */
  onStepRerun?: (step: TraceStep, dependents: number[]) => void;
  /** Registers notebook export handlers with the page-level Export menu
   *  (null when not exportable). The notebook renders no export UI itself. */
  onExportApiChange?: (api: NotebookExportApi | null) => void;
}) {
  // ── DAG-aware re-run state ──
  // overrides: fresh TraceSteps from re-runs, merged over the derived cells
  // (also pushed up via onStepRerun so the parent's artifacts stay in sync).
  // stale: cells whose upstream was re-run WITH EDITS — flagged, not auto-run.
  const [overrides, setOverrides] = useState<Map<number, TraceStep>>(new Map());
  const [stale, setStale] = useState<Set<number>>(new Set());
  const [rerunning, setRerunning] = useState<Set<number>>(new Set());
  const [rerunErrors, setRerunErrors] = useState<Map<number, string>>(new Map());
  // Cells composed lazily on Notebook-open (when the run skipped eager composes
  // because it was submitted from the Dashboard). Keyed by step index.
  const [lazyCells, setLazyCells] = useState<Map<number, Spec>>(new Map());
  const lazyFetchedRef = useRef<Set<number>>(new Set());
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset when the underlying investigation changes. A parent merge after a
  // re-run swaps the trace identity too — that only clears `overrides`
  // (whose data the merge just absorbed); stale flags survive until a NEW
  // analysis clears the artifacts entirely.
  const trace = artifacts?.investigation;
  // User notebook layout (markdown cells + ordering). null = default order.
  const [layout, setLayout] = useState<NotebookLayoutCell[] | null>(trace?.notebook?.cells ?? null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [prevTrace, setPrevTrace] = useState(trace);
  if (trace !== prevTrace) {
    setPrevTrace(trace);
    setOverrides(new Map());
    setLazyCells(new Map());
    lazyFetchedRef.current = new Set();
    // Adopt a newly-loaded layout, but don't clobber in-progress local edits
    // when the trace identity changes only because of a step re-run merge.
    if (trace?.notebook?.cells && layout === null) setLayout(trace.notebook.cells);
    if (!trace) {
      setStale(new Set());
      setRerunErrors(new Map());
      setLayout(null);
    }
  }

  // Persist layout changes (debounced). The saved layout is the FULL display
  // order so reloads reproduce it exactly.
  const commitLayout = useCallback(
    (next: NotebookLayoutCell[]) => {
      setLayout(next);
      if (!csvId) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveNotebookLayout(csvId, { cells: next }).catch(() => {
          // Non-fatal: layout stays in local state for the session.
        });
      }, 800);
    },
    [csvId]
  );
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    []
  );

  const handleRerunStep = useCallback(
    async (index: number, code?: string) => {
      if (!csvId) return;
      setRerunning((prev) => new Set(prev).add(index));
      setRerunErrors((prev) => {
        const next = new Map(prev);
        next.delete(index);
        return next;
      });
      try {
        const res = await rerunInvestigateStep({
          csvId,
          stepIndex: index,
          code,
          sandboxRuntime,
        });
        setOverrides((prev) => new Map(prev).set(index, res.step));
        setStale((prev) => {
          const next = new Set(prev);
          next.delete(index);
          // Only an EDITED re-run invalidates dependents; re-running a stale
          // cell with its stored code is a refresh, not a change.
          if (code !== undefined) {
            for (const d of res.dependents) next.add(d);
          }
          return next;
        });
        onStepRerun?.(res.step, code !== undefined ? res.dependents : []);
      } catch (err) {
        setRerunErrors((prev) =>
          new Map(prev).set(index, err instanceof Error ? err.message : String(err))
        );
      } finally {
        setRerunning((prev) => {
          const next = new Set(prev);
          next.delete(index);
          return next;
        });
      }
    },
    [csvId, sandboxRuntime, onStepRerun]
  );

  // Re-run every stale cell in ascending index order — depends_on always
  // points backwards, so that IS a topological order.
  const [rerunningStale, setRerunningStale] = useState(false);
  const handleRerunStale = useCallback(async () => {
    setRerunningStale(true);
    try {
      for (const idx of [...stale].sort((a, b) => a - b)) {
        await handleRerunStep(idx);
      }
    } finally {
      setRerunningStale(false);
    }
  }, [stale, handleRerunStep]);

  const derivedCells = buildNotebookCells(spec, artifacts);
  const cells = derivedCells.map((cell) => {
    const override = overrides.get(cell.index);
    const lazy = lazyCells.get(cell.index);
    if (!override) return lazy && !cell.cellSpec ? { ...cell, cellSpec: lazy } : cell;
    return {
      ...cell,
      status: normalizeStatus(override.status),
      degradedReason: override.degradedReason,
      error: override.error,
      cellSpec: override.cellSpec ?? cell.cellSpec ?? lazy,
      trace: override,
    };
  });
  const rerunEnabled = Boolean(csvId) && !isStreaming;
  const state = (spec?.state as Record<string, unknown> | undefined) ?? {};
  const plan = state.__plan as { approach?: string } | undefined;
  const approach = plan?.approach ?? artifacts?.investigation?.approach;

  // Lazy cell composition: when the run skipped eager composes (submitted from
  // Dashboard), compose the missing cells once now that the Notebook is open.
  // The per-step results/chart_data are already in the trace client-side.
  useEffect(() => {
    if (isStreaming) return;
    const originalQuestion = artifacts?.investigation?.originalQuestion ?? "";
    const need = derivedCells.filter(
      (c) =>
        (c.status === "done" || c.status === "degraded") &&
        !c.cellSpec &&
        !lazyCells.has(c.index) &&
        !overrides.get(c.index)?.cellSpec &&
        !lazyFetchedRef.current.has(c.index) &&
        c.trace &&
        (Object.keys(c.trace.results ?? {}).length > 0 ||
          Object.keys(c.trace.chart_data ?? {}).length > 0)
    );
    if (need.length === 0) return;
    // Mark before the await so a re-render mid-fetch (derivedCells gets a new
    // identity each render) doesn't re-dispatch. We intentionally do NOT cancel
    // the in-flight request on re-render — only skip the state write if the
    // component has unmounted (mountedRef).
    need.forEach((c) => lazyFetchedRef.current.add(c.index));
    (async () => {
      try {
        const res = await fetch("/api/query/investigate/compose-cell", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            original_question: originalQuestion,
            approach,
            steps: need.map((c) => ({
              index: c.index,
              stepNo: c.stepNo,
              question: c.question,
              rationale: c.rationale ?? "",
              results: c.trace?.results ?? {},
              chart_data: c.trace?.chart_data ?? {},
              degraded: c.status === "degraded",
              degradedReason: c.degradedReason,
            })),
          }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { cells?: Record<string, Spec> };
        if (!mountedRef.current || !data.cells) return;
        setLazyCells((prev) => {
          const next = new Map(prev);
          for (const [k, v] of Object.entries(data.cells!)) next.set(Number(k), v);
          return next;
        });
      } catch {
        // Best-effort: a failed lazy compose leaves the cell as a stub, and the
        // indices stay marked so we don't hammer the endpoint on every render.
      }
    })();
  }, [derivedCells, isStreaming, approach, artifacts, lazyCells, overrides]);
  // Stable identity so the export useCallback dep doesn't change every render.
  const synthesisRaw = state.__synthesis as SynthesisState | undefined;
  const synthesis = useMemo<SynthesisState>(() => synthesisRaw ?? {}, [synthesisRaw]);
  const grounding =
    (state.__grounding as GroundingLike | undefined) ?? artifacts?.investigation?.grounding;
  const decisions = artifacts?.investigation?.decisions;
  const hasSynthesis = Boolean(synthesis.summary || synthesis.conclusion);

  // Citation click-through: scroll to and briefly highlight the cited cell.
  const [highlightStepNo, setHighlightStepNo] = useState<number | null>(null);
  useEffect(() => {
    if (!scrollTarget) return;
    const el = document.getElementById(`notebook-cell-${scrollTarget.stepNo}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    setHighlightStepNo(scrollTarget.stepNo);
    const timer = setTimeout(() => setHighlightStepNo(null), 2000);
    return () => clearTimeout(timer);
  }, [scrollTarget]);

  // Export handlers — registered with the page-level Export menu (the
  // notebook renders no export UI of its own). The menu lives in the top
  // bar, outside containerRef, so captures never include export controls.
  const containerRef = useRef<HTMLDivElement>(null);
  const canExport = Boolean(trace) && !isStreaming;
  const handleExportMarkdown = useCallback(() => {
    if (!trace) return;
    const md = buildNotebookMarkdown(trace, synthesis);
    downloadCodeAsFile(md, `${sanitizeFilename(trace.originalQuestion || "notebook")}.md`);
  }, [trace, synthesis]);
  const handleExportPdf = useCallback(async () => {
    if (!containerRef.current || !trace) return;
    await downloadDashboardAsPdf(
      containerRef.current,
      `${sanitizeFilename(trace.originalQuestion || "notebook")}.pdf`
    );
  }, [trace]);
  // Self-contained HTML: capture each cell's rendered output as an inline PNG,
  // then assemble a single servable .html (inlined CSS + base64 images).
  const handleExportHtml = useCallback(async () => {
    if (!containerRef.current || !trace) return;
    const { toPng } = await import("html-to-image");
    const images = new Map<number, string>();
    for (const step of trace.steps) {
      if (step.status !== "success" && step.status !== "degraded") continue;
      const node = containerRef.current.querySelector(`[data-cell-output="${step.stepNo}"]`);
      if (!(node instanceof HTMLElement)) continue;
      try {
        images.set(step.stepNo, await toPng(node, { backgroundColor: "#ffffff", pixelRatio: 2 }));
      } catch {
        // Skip a cell whose output can't be snapshotted; the rest still export.
      }
    }
    const html = buildNotebookHtml(trace, synthesis, images);
    downloadCodeAsFile(html, `${sanitizeFilename(trace.originalQuestion || "notebook")}.html`);
  }, [trace, synthesis]);

  const handleExportSlides = useCallback(async () => {
    if (!containerRef.current || !trace) return;
    await downloadAsSlides(containerRef.current, trace.originalQuestion || "notebook");
  }, [trace]);

  // Register/unregister the export handlers with the page menu.
  useEffect(() => {
    if (!onExportApiChange) return;
    onExportApiChange(
      canExport
        ? {
            markdown: handleExportMarkdown,
            html: handleExportHtml,
            pdf: handleExportPdf,
            slides: handleExportSlides,
          }
        : null
    );
    return () => onExportApiChange(null);
  }, [
    onExportApiChange,
    canExport,
    handleExportMarkdown,
    handleExportHtml,
    handleExportPdf,
    handleExportSlides,
  ]);

  if (cells.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-t-tertiary" role="status">
        {isStreaming ? "Planning the investigation…" : "No investigation steps to show."}
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex flex-col gap-3"
      data-testid="notebook-view"
      data-slides-root
    >
      {approach && (
        <p className="px-1 text-xs text-t-tertiary">
          <span className="font-medium text-t-secondary">Approach:</span> {approach}
        </p>
      )}
      {stale.size > 0 && (
        <div
          className="flex items-center justify-between gap-2 border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-text"
          style={{ borderRadius: "var(--radius-card)" }}
        >
          <span>
            {stale.size} cell{stale.size === 1 ? "" : "s"} depend on a step that was re-run with
            edits.
          </span>
          <button
            onClick={handleRerunStale}
            disabled={rerunningStale}
            className="shrink-0 font-medium underline hover:no-underline disabled:opacity-50"
          >
            {rerunningStale
              ? "Re-running…"
              : `Re-run ${stale.size} stale cell${stale.size === 1 ? "" : "s"}`}
          </button>
        </div>
      )}
      {(() => {
        // Layout editing is enabled once streaming finishes and we have a
        // csvId to persist against.
        const editable = Boolean(csvId) && !isStreaming;
        const entries = orderedEntries(layout, cells);
        // The full current order, as a saveable layout — every edit derives
        // from this so reloads reproduce the exact order.
        const asLayout = (es: RenderEntry[]): NotebookLayoutCell[] =>
          es.map((e) =>
            e.kind === "markdown"
              ? { kind: "markdown", id: e.id, content: e.content }
              : { kind: "step", stepNo: e.cell.stepNo }
          );
        const full = asLayout(entries);
        const move = (pos: number, dir: -1 | 1) => {
          const next = [...full];
          const j = pos + dir;
          if (j < 0 || j >= next.length) return;
          [next[pos], next[j]] = [next[j], next[pos]];
          commitLayout(next);
        };
        const addMarkdownAfter = (pos: number) => {
          const next = [...full];
          next.splice(pos + 1, 0, { kind: "markdown", id: crypto.randomUUID(), content: "" });
          commitLayout(next);
        };
        const updateMarkdown = (id: string, content: string) =>
          commitLayout(
            full.map((c) => (c.kind === "markdown" && c.id === id ? { ...c, content } : c))
          );
        const deleteAt = (pos: number) => commitLayout(full.filter((_, i) => i !== pos));

        return entries.map((entry, pos) => (
          <div key={entry.kind === "markdown" ? `md-${entry.id}` : `step-${entry.cell.index}`}>
            {entry.kind === "markdown" ? (
              <MarkdownCell
                content={entry.content}
                editable={editable}
                onChange={(c) => updateMarkdown(entry.id, c)}
                onDelete={() => deleteAt(pos)}
              />
            ) : (
              <NotebookCell
                cell={entry.cell}
                isStreaming={isStreaming}
                highlighted={highlightStepNo === entry.cell.stepNo}
                stale={stale.has(entry.cell.index)}
                rerunning={rerunning.has(entry.cell.index)}
                rerunError={rerunErrors.get(entry.cell.index)}
                onRerun={rerunEnabled ? handleRerunStep : undefined}
              />
            )}
            {editable && (
              <CellControls
                onMoveUp={pos > 0 ? () => move(pos, -1) : undefined}
                onMoveDown={pos < entries.length - 1 ? () => move(pos, 1) : undefined}
                onAddMarkdown={() => addMarkdownAfter(pos)}
              />
            )}
          </div>
        ));
      })()}
      {hasSynthesis && (
        <SynthesisCell synthesis={synthesis} grounding={grounding} decisions={decisions} />
      )}
      {!hasSynthesis && isStreaming && cells.some((c) => c.status === "done") && (
        <p className="px-1 py-2 text-center text-xs text-t-tertiary">
          Synthesis appears here when the investigation completes…
        </p>
      )}
    </div>
  );
}
