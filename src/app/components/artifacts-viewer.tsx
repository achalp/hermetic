"use client";

import { useState, useCallback, useMemo } from "react";
import {
  downloadTableAsCsv,
  downloadTableAsXlsx,
  downloadMultiSheetXlsx,
  downloadCodeAsFile,
  sanitizeFilename,
} from "@/lib/export-utils";
import type { CachedArtifacts } from "@/lib/contracts/investigation";
import type { InvestigationTrace, TraceStep } from "@/lib/contracts/investigation";
import type { FindingsManifest } from "@/lib/contracts/findings";
import { CodeEditor } from "./code-editor";
import { FindingsTab, GroundingAdvisories } from "./findings-tab";
import { rerunCode, ApiError } from "@/app/lib/api";

interface ArtifactsViewerProps {
  artifacts: CachedArtifacts;
  /**
   * Declared-findings manifest for this run (declared-findings spec §11
   * phase 1). Optional twice over: legacy runs have none, and the pipeline
   * threading lands separately — when omitted we also probe the artifacts
   * payload itself, which gains an optional `findings` field.
   */
  findings?: FindingsManifest;
  /** csv_id — required for re-run. When omitted, the editor is read-only. */
  csvId?: string | null;
  /** Active sandbox runtime, passed through to the rerun endpoint. */
  sandboxRuntime?: string;
  /** Called after a successful artifacts-only rerun with the fresh artifacts. */
  onRerunSuccess?: (artifacts: CachedArtifacts) => void;
  /**
   * If provided, Re-run delegates to this callback instead of calling
   * /api/query/rerun. Used by page.tsx to drive a full dashboard rebuild
   * via the streaming pipeline.
   *
   * The argument is an object so a single callback handles both Python
   * edits (`{code}`) and SQL edits (`{sql}`). The editor closes the
   * artifacts panel after dispatching so the user sees the new dashboard.
   */
  onRequestRerun?: (edits: { code?: string; sql?: string }) => void;
}

type Tab = "trail" | "sql" | "code" | "data" | "findings";

/** A normalized view of one artifacts source — either the top-level cached
 *  result or a single investigation step the user selected from the trail. */
interface ArtifactsView {
  code: string;
  question: string;
  results: Record<string, unknown>;
  chart_data: Record<string, unknown>;
  datasets: Record<string, Record<string, unknown>[]>;
  execution_ms: number;
  sql?: string;
}

// Exported for reuse by the notebook view's per-cell data disclosure.
export function recordsToTable(records: Record<string, unknown>[]): {
  columns: string[];
  rows: string[][];
} {
  if (records.length === 0) return { columns: [], rows: [] };
  const columns = Object.keys(records[0]);
  const rows = records.map((r) =>
    columns.map((c) => {
      const v = r[c];
      if (v === null || v === undefined) return "";
      if (typeof v === "object") return JSON.stringify(v);
      return String(v);
    })
  );
  return { columns, rows };
}

function kvToTable(obj: Record<string, unknown>): {
  columns: string[];
  rows: string[][];
} {
  const columns = ["Key", "Value"];
  const rows = Object.entries(obj).map(([k, v]) => [
    k,
    typeof v === "object" ? JSON.stringify(v) : String(v ?? ""),
  ]);
  return { columns, rows };
}

export function MiniTable({
  columns,
  rows,
  maxRows = 50,
}: {
  columns: string[];
  rows: string[][];
  maxRows?: number;
}) {
  const visible = rows.slice(0, maxRows);
  return (
    <div>
      <div
        className="overflow-x-auto border border-border-default"
        style={{ borderRadius: "var(--radius-badge)" }}
      >
        <table className="min-w-full text-xs">
          <thead>
            <tr className="bg-table-header-bg">
              {columns.map((c, i) => (
                <th
                  key={i}
                  className="whitespace-nowrap px-3 py-1.5 text-left font-medium text-t-secondary"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row, ri) => (
              <tr key={ri} className="border-t border-table-divider">
                {row.map((cell, ci) => (
                  <td key={ci} className="whitespace-nowrap px-3 py-1 text-t-primary">
                    {cell.length > 80 ? cell.slice(0, 80) + "\u2026" : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > maxRows && (
        <p className="mt-1 text-xs text-t-secondary">
          Showing {maxRows} of {rows.length} rows
        </p>
      )}
    </div>
  );
}

function DataSection({
  title,
  columns,
  rows,
  sectionName,
}: {
  title: string;
  columns: string[];
  rows: string[][];
  sectionName: string;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="border-b border-table-divider pb-3">
      <div className="flex items-center justify-between">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 text-sm font-medium text-t-secondary"
        >
          <span className="text-xs">{open ? "\u25BC" : "\u25B6"}</span>
          {title}
          <span className="text-xs font-normal text-t-tertiary">
            ({rows.length} row{rows.length !== 1 ? "s" : ""})
          </span>
        </button>
        <div className="flex gap-1.5">
          <button
            onClick={() => downloadTableAsCsv(columns, rows, sectionName)}
            className="bg-surface-btn px-2 py-0.5 text-xs text-t-btn hover:bg-surface-btn-hover transition-colors"
            style={{
              borderRadius: "var(--radius-badge)",
              transitionDuration: "var(--transition-speed)",
            }}
          >
            CSV
          </button>
          <button
            onClick={() => downloadTableAsXlsx(columns, rows, sectionName)}
            className="bg-surface-btn px-2 py-0.5 text-xs text-t-btn hover:bg-surface-btn-hover transition-colors"
            style={{
              borderRadius: "var(--radius-badge)",
              transitionDuration: "var(--transition-speed)",
            }}
          >
            XLSX
          </button>
        </div>
      </div>
      {open && <MiniTable columns={columns} rows={rows} />}
    </div>
  );
}

export function ArtifactsViewer({
  artifacts,
  findings: findingsProp,
  csvId,
  sandboxRuntime,
  onRerunSuccess,
  onRequestRerun,
}: ArtifactsViewerProps) {
  const investigation = artifacts.investigation;
  const [copied, setCopied] = useState(false);

  // UI-layer widening only: the artifacts payload gains an optional
  // `findings` in the pipeline threading that lands in parallel; the shared
  // CachedArtifacts contract is not ours to edit from here, so we probe.
  const findings =
    findingsProp ?? (artifacts as CachedArtifacts & { findings?: FindingsManifest }).findings;

  // Investigation trail: which step (if any) the user is inspecting. `null`
  // means the default top-level view (the last successful step's artifacts).
  const [activeStepNo, setActiveStepNo] = useState<number | null>(null);
  const activeStep =
    activeStepNo != null ? investigation?.steps.find((s) => s.stepNo === activeStepNo) : undefined;

  // The artifacts source the Code / Data tabs render: a selected step, or the
  // top-level cache. A step carries no SQL, so the SQL tab hides while a step
  // is selected (correct — Investigate steps are Python-only).
  const view: ArtifactsView = activeStep
    ? {
        code: activeStep.code ?? "",
        question: activeStep.question,
        results: activeStep.results ?? {},
        chart_data: activeStep.chart_data ?? {},
        datasets: activeStep.datasets ?? {},
        execution_ms: activeStep.execution_ms ?? 0,
        sql: undefined,
      }
    : {
        code: artifacts.code,
        question: artifacts.question,
        results: artifacts.results,
        chart_data: artifacts.chart_data,
        datasets: artifacts.datasets,
        execution_ms: artifacts.execution_ms,
        sql: artifacts.sql,
      };

  const [tab, setTab] = useState<Tab>(investigation ? "trail" : view.sql ? "sql" : "code");

  // Editable code state, keyed by view source ("top" or a trail step) so
  // navigating the trail never destroys in-progress edits on another view.
  // Cleared only when a NEW artifacts object arrives (fresh server result).
  const viewKey = activeStepNo != null ? `step-${activeStepNo}` : "top";
  const [editsByView, setEditsByView] = useState<Record<string, string>>({});

  // Editable SQL state — only meaningful at the top-level view of a
  // warehouse-sourced analysis (trail steps are Python-only). Survives trail
  // navigation; resets only on a fresh artifacts object.
  const [editedSql, setEditedSql] = useState(artifacts.sql ?? "");

  // Reconcile UI state when a different artifacts object arrives (new
  // analysis, rerun result, history load). Derived-state-from-props pattern
  // (no useEffect): without this, `tab` can point at a tab that no longer
  // exists (e.g. stuck on "trail" after an Ask replaced an Investigate →
  // blank panel) and a stale activeStepNo can silently select the
  // same-numbered step of an unrelated trace.
  // Pending code_ref deep-link target from the Findings tab. The nonce lets
  // a second click on the same ref re-trigger the scroll.
  const [codeTarget, setCodeTarget] = useState<{ line: number; nonce: number } | null>(null);

  const [prevArtifacts, setPrevArtifacts] = useState(artifacts);
  if (artifacts !== prevArtifacts) {
    setPrevArtifacts(artifacts);
    setActiveStepNo(null);
    setTab(investigation ? "trail" : artifacts.sql ? "sql" : "code");
    setEditsByView({});
    setEditedSql(artifacts.sql ?? "");
    setCodeTarget(null);
  }

  // Findings-tab code_ref click → Python tab, scrolled to the cited line.
  // code_ref line numbers are generated-code-relative (spec §2.4), i.e. they
  // index the TOP-LEVEL script — so clear any selected trail step, whose
  // editor shows different code.
  const openCodeRef = useCallback((line: number) => {
    setActiveStepNo(null);
    setTab("code");
    setCodeTarget((t) => ({ line, nonce: (t?.nonce ?? 0) + 1 }));
  }, []);

  const editedCode = editsByView[viewKey] ?? view.code;
  const setEditedCode = useCallback(
    (code: string) => setEditsByView((m) => ({ ...m, [viewKey]: code })),
    [viewKey]
  );

  const codeIsDirty = editedCode !== view.code;
  const sqlIsDirty = !!view.sql && editedSql !== view.sql;

  const [rerunState, setRerunState] = useState<
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "success" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const copyTarget =
    tab === "sql"
      ? sqlIsDirty
        ? editedSql
        : (view.sql ?? "")
      : codeIsDirty
        ? editedCode
        : view.code;

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(copyTarget);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [copyTarget]);

  const handleDownloadPy = useCallback(() => {
    downloadCodeAsFile(
      codeIsDirty ? editedCode : view.code,
      `${sanitizeFilename(view.question)}.py`
    );
  }, [view.code, view.question, codeIsDirty, editedCode]);

  const handleDownloadSql = useCallback(() => {
    if (view.sql) {
      downloadCodeAsFile(
        sqlIsDirty ? editedSql : view.sql,
        `${sanitizeFilename(view.question)}.sql`
      );
    }
  }, [view.sql, view.question, sqlIsDirty, editedSql]);

  const handleDiscardCodeEdits = useCallback(() => {
    setEditsByView((m) => {
      const next = { ...m };
      delete next[viewKey];
      return next;
    });
    setRerunState({ kind: "idle" });
  }, [viewKey]);

  const handleDiscardSqlEdits = useCallback(() => {
    setEditedSql(view.sql ?? "");
    setRerunState({ kind: "idle" });
  }, [view.sql]);

  const handleRerunCode = useCallback(async () => {
    if (!csvId) return;
    if (!codeIsDirty) return;

    // Path A (preferred): parent handles the rerun by dispatching to the
    // streaming pipeline, which rebuilds the full dashboard.
    if (onRequestRerun) {
      onRequestRerun({ code: editedCode });
      return;
    }

    // Path B (fallback): legacy artifacts-only refresh via /api/query/rerun.
    setRerunState({ kind: "running" });
    try {
      const result = await rerunCode(csvId, editedCode, sandboxRuntime);
      onRerunSuccess?.(result.artifacts);
      setRerunState({ kind: "success" });
      setTimeout(() => setRerunState({ kind: "idle" }), 3000);
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      setRerunState({ kind: "error", message: msg });
    }
  }, [csvId, codeIsDirty, editedCode, sandboxRuntime, onRerunSuccess, onRequestRerun]);

  const handleRerunSql = useCallback(() => {
    if (!sqlIsDirty) return;

    // SQL editing always takes the dashboard-rebuild path — the result CSV's
    // schema may change, so artifacts-only refresh is not safe.
    if (onRequestRerun) {
      onRequestRerun({ sql: editedSql });
      return;
    }

    // No fallback: SQL editing without the parent dispatch can't work,
    // because /api/query/rerun is artifacts-only and doesn't touch the
    // warehouse. Surface a clear error instead of silently doing nothing.
    setRerunState({
      kind: "error",
      message:
        "SQL edit requires the full dashboard rebuild path. This artifacts viewer was opened without one wired up.",
    });
  }, [sqlIsDirty, editedSql, onRequestRerun]);

  // Build data sections
  const dataSections = useMemo(() => {
    const sections: {
      title: string;
      columns: string[];
      rows: string[][];
      name: string;
    }[] = [];

    // Results as key-value
    if (view.results && typeof view.results === "object" && Object.keys(view.results).length > 0) {
      const { columns, rows } = kvToTable(view.results);
      sections.push({ title: "Results", columns, rows, name: "results" });
    }

    // Chart data
    if (view.chart_data) {
      for (const [key, val] of Object.entries(view.chart_data)) {
        if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object") {
          const { columns, rows } = recordsToTable(val as Record<string, unknown>[]);
          sections.push({
            title: `chart_data.${key}`,
            columns,
            rows,
            name: `chart_data_${key}`,
          });
        }
      }
    }

    // Datasets
    if (view.datasets) {
      for (const [key, val] of Object.entries(view.datasets)) {
        if (Array.isArray(val) && val.length > 0) {
          const { columns, rows } = recordsToTable(val);
          sections.push({
            title: `datasets.${key}`,
            columns,
            rows,
            name: `dataset_${key}`,
          });
        }
      }
    }

    return sections;
  }, [view.results, view.chart_data, view.datasets]);

  const handleDownloadAll = useCallback(async () => {
    const sheets = dataSections.map((s) => ({
      name: s.name.slice(0, 31),
      headers: s.columns,
      rows: s.rows,
    }));
    if (sheets.length === 0) return;
    await downloadMultiSheetXlsx(sheets, sanitizeFilename(view.question) + "_all");
  }, [dataSections, view.question]);

  return (
    <div
      className="theme-card border border-border-default bg-surface-1 overflow-hidden"
      style={{ borderRadius: "var(--radius-card)", boxShadow: "var(--shadow-card)" }}
    >
      {/* Tab bar */}
      <div className="flex items-center border-b border-border-default">
        {investigation && (
          <button
            onClick={() => setTab("trail")}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              tab === "trail"
                ? "border-b-2 border-accent text-accent"
                : "text-t-secondary hover:text-t-primary"
            }`}
            style={{ transitionDuration: "var(--transition-speed)" }}
          >
            Trail
          </button>
        )}
        {view.sql && (
          <button
            onClick={() => setTab("sql")}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              tab === "sql"
                ? "border-b-2 border-accent text-accent"
                : "text-t-secondary hover:text-t-primary"
            }`}
            style={{ transitionDuration: "var(--transition-speed)" }}
          >
            SQL
          </button>
        )}
        <button
          onClick={() => setTab("code")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            tab === "code"
              ? "border-b-2 border-accent text-accent"
              : "text-t-secondary hover:text-t-primary"
          }`}
          style={{ transitionDuration: "var(--transition-speed)" }}
        >
          Python
        </button>
        <button
          onClick={() => setTab("data")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            tab === "data"
              ? "border-b-2 border-accent text-accent"
              : "text-t-secondary hover:text-t-primary"
          }`}
          style={{ transitionDuration: "var(--transition-speed)" }}
        >
          Data
        </button>
        {/* Always shown — a legacy run must say "no manifest", never hide
            the surface (spec §6, review P11). */}
        <button
          onClick={() => setTab("findings")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            tab === "findings"
              ? "border-b-2 border-accent text-accent"
              : "text-t-secondary hover:text-t-primary"
          }`}
          style={{ transitionDuration: "var(--transition-speed)" }}
        >
          Findings
        </button>
        <span className="ml-auto mr-4 flex items-center gap-3 text-xs text-t-tertiary">
          {activeStep && tab !== "trail" && (
            <button
              onClick={() => setTab("trail")}
              className="text-accent hover:underline"
              title="Back to the investigation trail"
            >
              ← Step {activeStep.stepNo} · back to trail
            </button>
          )}
          {view.execution_ms > 0 && (
            <span>Executed in {(view.execution_ms / 1000).toFixed(1)}s</span>
          )}
        </span>
      </div>

      {/* SQL tab — editable when source is a warehouse and a parent rerun
          callback is wired up. Re-run executes against the warehouse,
          producing a fresh CSV → fresh Python code-gen → fresh dashboard. */}
      {tab === "trail" && investigation && (
        <InvestigationTrail
          trace={investigation}
          activeStepNo={activeStepNo}
          onSelectStep={(stepNo) => {
            setActiveStepNo(stepNo);
            setTab("code");
          }}
          onClearStep={() => setActiveStepNo(null)}
        />
      )}

      {tab === "sql" && view.sql && (
        <div>
          <div className="flex flex-wrap items-center gap-2 border-b border-table-divider px-4 py-2">
            <button
              onClick={handleCopy}
              className="bg-surface-btn px-2.5 py-1 text-xs font-medium text-t-btn hover:bg-surface-btn-hover transition-colors"
              style={{
                borderRadius: "var(--radius-badge)",
                transitionDuration: "var(--transition-speed)",
              }}
            >
              {copied ? "\u2713 Copied" : "Copy"}
            </button>
            <button
              onClick={handleDownloadSql}
              className="bg-surface-btn px-2.5 py-1 text-xs font-medium text-t-btn hover:bg-surface-btn-hover transition-colors"
              style={{
                borderRadius: "var(--radius-badge)",
                transitionDuration: "var(--transition-speed)",
              }}
            >
              Download .sql
            </button>
            {sqlIsDirty && onRequestRerun && (
              <>
                <button
                  onClick={handleRerunSql}
                  className="bg-accent text-white px-2.5 py-1 text-xs font-medium hover:opacity-90 transition-opacity"
                  style={{
                    borderRadius: "var(--radius-badge)",
                    transitionDuration: "var(--transition-speed)",
                  }}
                >
                  Re-run
                </button>
                <button
                  onClick={handleDiscardSqlEdits}
                  className="bg-surface-btn px-2.5 py-1 text-xs font-medium text-t-btn hover:bg-surface-btn-hover transition-colors"
                  style={{
                    borderRadius: "var(--radius-badge)",
                    transitionDuration: "var(--transition-speed)",
                  }}
                >
                  Discard
                </button>
              </>
            )}
            {sqlIsDirty && (
              <span
                className="text-xs"
                style={{ color: "var(--color-surface-dark-text3)", marginLeft: 4 }}
              >
                {onRequestRerun
                  ? "edited — re-run or discard"
                  : "edited (read-only without rerun callback)"}
              </span>
            )}
            {rerunState.kind === "error" && tab === "sql" && (
              <span style={{ fontSize: 11, color: "var(--color-error-text)", marginLeft: 4 }}>
                {rerunState.message}
              </span>
            )}
          </div>
          <CodeEditor
            value={editedSql}
            language="sql"
            readOnly={!onRequestRerun}
            onChange={onRequestRerun ? setEditedSql : undefined}
            height={360}
          />
          {!sqlIsDirty && onRequestRerun && (
            <p className="px-4 py-2 text-xs" style={{ color: "var(--color-surface-dark-text3)" }}>
              Tip: edit the SQL and click Re-run to query the warehouse with your changes. The
              dashboard rebuilds against the new result columns.
            </p>
          )}
        </div>
      )}

      {/* Code tab — editable, with Re-run + Discard */}
      {tab === "code" && (
        <div>
          <div className="flex flex-wrap items-center gap-2 border-b border-table-divider px-4 py-2">
            <button
              onClick={handleCopy}
              className="bg-surface-btn px-2.5 py-1 text-xs font-medium text-t-btn hover:bg-surface-btn-hover transition-colors"
              style={{
                borderRadius: "var(--radius-badge)",
                transitionDuration: "var(--transition-speed)",
              }}
            >
              {copied ? "\u2713 Copied" : "Copy"}
            </button>
            <button
              onClick={handleDownloadPy}
              className="bg-surface-btn px-2.5 py-1 text-xs font-medium text-t-btn hover:bg-surface-btn-hover transition-colors"
              style={{
                borderRadius: "var(--radius-badge)",
                transitionDuration: "var(--transition-speed)",
              }}
            >
              Download .py
            </button>
            {codeIsDirty && csvId && (
              <>
                <button
                  onClick={handleRerunCode}
                  disabled={rerunState.kind === "running"}
                  className="bg-accent text-white px-2.5 py-1 text-xs font-medium hover:opacity-90 transition-opacity"
                  style={{
                    borderRadius: "var(--radius-badge)",
                    transitionDuration: "var(--transition-speed)",
                    opacity: rerunState.kind === "running" ? 0.6 : 1,
                  }}
                >
                  {rerunState.kind === "running" ? "Running..." : "Re-run"}
                </button>
                <button
                  onClick={handleDiscardCodeEdits}
                  className="bg-surface-btn px-2.5 py-1 text-xs font-medium text-t-btn hover:bg-surface-btn-hover transition-colors"
                  style={{
                    borderRadius: "var(--radius-badge)",
                    transitionDuration: "var(--transition-speed)",
                  }}
                >
                  Discard
                </button>
              </>
            )}
            {codeIsDirty && (
              <span
                className="text-xs"
                style={{ color: "var(--color-surface-dark-text3)", marginLeft: 4 }}
              >
                {csvId ? "edited — re-run or discard" : "edited (read-only without csv)"}
              </span>
            )}
            {rerunState.kind === "success" && (
              <span style={{ fontSize: 11, color: "var(--color-success-text)", marginLeft: 4 }}>
                ✓ executed — see Data tab
              </span>
            )}
            {rerunState.kind === "error" && (
              <span style={{ fontSize: 11, color: "var(--color-error-text)", marginLeft: 4 }}>
                {rerunState.message}
              </span>
            )}
          </div>
          <CodeEditor
            value={editedCode}
            language="python"
            readOnly={!csvId}
            onChange={setEditedCode}
            height={360}
            // Deep-link only at the top-level view: code_ref lines index the
            // top-level generated script, not a trail step's.
            scrollToLine={activeStepNo == null && codeTarget ? codeTarget : undefined}
          />
          {!view.sql && rerunState.kind === "idle" && csvId && (
            <p className="px-4 py-2 text-xs" style={{ color: "var(--color-surface-dark-text3)" }}>
              {activeStep
                ? `Step ${activeStep.stepNo}'s Python — edit and Re-run to rebuild the dashboard from this step's code.`
                : "Tip: edit and Re-run to refresh the computed values shown in the Data tab. To rebuild the dashboard from new code, ask a follow-up question."}
            </p>
          )}
        </div>
      )}

      {/* Findings tab — the declared-findings inspectability surface
          (spec §11 phase 1); code_ref links jump into the Python tab. */}
      {tab === "findings" && <FindingsTab findings={findings} onOpenCodeRef={openCodeRef} />}

      {/* Data tab */}
      {tab === "data" && (
        <div className="space-y-4 p-4">
          {dataSections.length > 1 && (
            <div className="flex justify-end">
              <button
                onClick={handleDownloadAll}
                className="bg-accent-subtle px-3 py-1 text-xs font-medium text-accent-text hover:bg-accent/10 transition-colors"
                style={{
                  borderRadius: "var(--radius-badge)",
                  transitionDuration: "var(--transition-speed)",
                }}
              >
                Download All XLSX
              </button>
            </div>
          )}
          {dataSections.length === 0 && (
            <p className="text-sm text-t-secondary">No data artifacts available.</p>
          )}
          {dataSections.map((s) => (
            <DataSection
              key={s.name}
              title={s.title}
              columns={s.columns}
              rows={s.rows}
              sectionName={s.name}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Investigation trail ───────────────────────────────────────────────

const STATUS_STYLE: Record<TraceStep["status"], { label: string; color: string }> = {
  success: { label: "✓ success", color: "var(--color-success-text)" },
  degraded: { label: "▲ degraded", color: "var(--color-warning-text)" },
  failed: { label: "✕ failed", color: "var(--color-error-text)" },
  removed: { label: "— dropped", color: "var(--color-t-tertiary)" },
};

const SOURCE_LABEL: Record<TraceStep["source"], string> = {
  initial: "planned",
  replanner: "added by re-planner",
  composer: "added by composer",
};

/**
 * The audit trail for an Investigate run: the plan approach, the narrative
 * grounding verdict, every sub-question with its status + provenance, and the
 * re-planner / composer decisions. Selecting a step with code routes the
 * Python + Data tabs to that step so it can be inspected and re-run.
 */
function InvestigationTrail({
  trace,
  activeStepNo,
  onSelectStep,
  onClearStep,
}: {
  trace: InvestigationTrace;
  activeStepNo: number | null;
  onSelectStep: (stepNo: number) => void;
  onClearStep: () => void;
}) {
  const g = trace.grounding;
  return (
    <div className="space-y-4 p-4 text-sm">
      {/* Approach */}
      {trace.approach && (
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-t-tertiary">
            Approach
          </div>
          <p className="mt-1 text-t-primary">{trace.approach}</p>
        </div>
      )}

      {/* Grounding verdict */}
      {g && (
        <div
          className="border border-border-default p-3"
          style={{ borderRadius: "var(--radius-card)" }}
        >
          <div className="text-xs font-medium uppercase tracking-wide text-t-tertiary">
            Narrative grounding
          </div>
          {g.checkedCount === 0 ? (
            <p className="mt-1 text-t-secondary">No quantitative claims to verify.</p>
          ) : g.ok ? (
            <p className="mt-1" style={{ color: "var(--color-success-text)" }}>
              ✓ All {g.checkedCount} figure{g.checkedCount === 1 ? "" : "s"} in the narrative trace
              to a computed result.
            </p>
          ) : (
            <p className="mt-1" style={{ color: "var(--color-warning-text)" }}>
              ▲ {g.ungrounded.length} figure{g.ungrounded.length === 1 ? "" : "s"} could not be
              traced to a computed result — verify before relying on{" "}
              {g.ungrounded.length === 1 ? "it" : "them"}:{" "}
              <span className="font-medium">{g.ungrounded.join(", ")}</span>
            </p>
          )}
          {g.uncitedSuccessfulSteps.length > 0 && (
            <p className="mt-1 text-xs text-t-tertiary">
              Computed but not referenced in the narrative: Step{" "}
              {g.uncitedSuccessfulSteps.join(", Step ")}.
            </p>
          )}
          {/* Findings-era advisory checks (contradictions, un-narrated
              findings, …) — same fields the caveat banner surfaces. */}
          <GroundingAdvisories grounding={g} />
        </div>
      )}

      {/* Steps */}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-t-tertiary">
            Sub-questions ({trace.steps.length})
          </span>
          {activeStepNo != null && (
            <button onClick={onClearStep} className="text-xs text-accent hover:underline">
              Clear selection
            </button>
          )}
        </div>
        <ol className="flex flex-col gap-2">
          {trace.steps.map((step) => {
            const runnable = !!step.code;
            const isActive = step.stepNo === activeStepNo;
            const st = STATUS_STYLE[step.status];
            return (
              <li
                key={step.index}
                className="border px-3 py-2"
                style={{
                  borderRadius: "var(--radius-card)",
                  borderColor: isActive ? "var(--color-accent)" : "var(--color-border-default)",
                  background: isActive ? "var(--color-accent-subtle, transparent)" : "transparent",
                  opacity: step.status === "removed" ? 0.6 : 1,
                }}
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium text-t-primary">Step {step.stepNo}</span>
                  <span style={{ color: st.color, fontSize: 11 }}>{st.label}</span>
                  {step.source !== "initial" && (
                    <span className="text-t-tertiary" style={{ fontSize: 11 }}>
                      · {SOURCE_LABEL[step.source]}
                    </span>
                  )}
                  {step.depends_on.length > 0 && (
                    <span className="text-t-tertiary" style={{ fontSize: 11 }}>
                      · depends on Step {step.depends_on.map((d) => d + 1).join(", ")}
                    </span>
                  )}
                </div>
                <div
                  className="mt-0.5 text-t-primary"
                  style={{ textDecoration: step.status === "removed" ? "line-through" : "none" }}
                >
                  {step.question}
                </div>
                {step.rationale && (
                  <div className="mt-0.5 text-xs text-t-tertiary">{step.rationale}</div>
                )}
                {step.degradedReason && (
                  <div className="mt-1 text-xs" style={{ color: "var(--color-warning-text)" }}>
                    Validator: {step.degradedReason}
                  </div>
                )}
                {step.error && (
                  <div className="mt-1 text-xs" style={{ color: "var(--color-error-text)" }}>
                    Error: {step.error.slice(0, 200)}
                  </div>
                )}
                {runnable && (
                  <button
                    onClick={() => onSelectStep(step.stepNo)}
                    className="mt-1.5 text-xs text-accent hover:underline"
                  >
                    {isActive ? "Viewing code & data" : "View code & data →"}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      {/* Decisions */}
      {trace.decisions.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-t-tertiary">
            Agent decisions
          </div>
          <ol className="flex flex-col gap-1.5">
            {trace.decisions.map((d, i) => (
              <li key={i} className="text-xs text-t-secondary">
                <span className="font-medium text-t-primary">
                  {d.kind === "replan"
                    ? `Re-planner: ${d.action ?? "evaluate"}`
                    : "Composer dispatch"}
                </span>
                {d.rationale ? ` — ${d.rationale}` : ""}
                {d.addedIndices.length > 0 && (
                  <span className="text-t-tertiary">
                    {" "}
                    (added Step {d.addedIndices.map((x) => x + 1).join(", ")})
                  </span>
                )}
                {d.removedIndices.length > 0 && (
                  <span className="text-t-tertiary">
                    {" "}
                    (dropped Step {d.removedIndices.map((x) => x + 1).join(", ")})
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
