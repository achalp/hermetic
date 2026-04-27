"use client";

import { useState, useCallback, useMemo } from "react";
import {
  downloadTableAsCsv,
  downloadTableAsXlsx,
  downloadMultiSheetXlsx,
  downloadCodeAsFile,
  sanitizeFilename,
} from "@/lib/export-utils";
import type { CachedArtifacts } from "@/lib/pipeline/artifacts-cache";
import { CodeEditor } from "./code-editor";
import { rerunCode, ApiError } from "@/lib/api";

interface ArtifactsViewerProps {
  artifacts: CachedArtifacts;
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

type Tab = "sql" | "code" | "data";

function recordsToTable(records: Record<string, unknown>[]): {
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

function MiniTable({
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
  csvId,
  sandboxRuntime,
  onRerunSuccess,
  onRequestRerun,
}: ArtifactsViewerProps) {
  const [tab, setTab] = useState<Tab>(artifacts.sql ? "sql" : "code");
  const [copied, setCopied] = useState(false);

  // Editable code state. Resets when the underlying server code changes.
  // Use derived-state-from-props pattern (no useEffect) — track the prior
  // server value and reset the editor when it changes.
  const [editedCode, setEditedCode] = useState(artifacts.code);
  const [prevServerCode, setPrevServerCode] = useState(artifacts.code);
  if (artifacts.code !== prevServerCode) {
    setPrevServerCode(artifacts.code);
    setEditedCode(artifacts.code);
  }

  const codeIsDirty = editedCode !== artifacts.code;

  // Editable SQL state — only meaningful when artifacts.sql is set
  // (i.e. the source is a warehouse). Resets when the server SQL changes.
  const [editedSql, setEditedSql] = useState(artifacts.sql ?? "");
  const [prevServerSql, setPrevServerSql] = useState(artifacts.sql ?? "");
  const incomingSql = artifacts.sql ?? "";
  if (incomingSql !== prevServerSql) {
    setPrevServerSql(incomingSql);
    setEditedSql(incomingSql);
  }

  const sqlIsDirty = !!artifacts.sql && editedSql !== artifacts.sql;

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
        : (artifacts.sql ?? "")
      : codeIsDirty
        ? editedCode
        : artifacts.code;

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(copyTarget);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [copyTarget]);

  const handleDownloadPy = useCallback(() => {
    downloadCodeAsFile(
      codeIsDirty ? editedCode : artifacts.code,
      `${sanitizeFilename(artifacts.question)}.py`
    );
  }, [artifacts.code, artifacts.question, codeIsDirty, editedCode]);

  const handleDownloadSql = useCallback(() => {
    if (artifacts.sql) {
      downloadCodeAsFile(
        sqlIsDirty ? editedSql : artifacts.sql,
        `${sanitizeFilename(artifacts.question)}.sql`
      );
    }
  }, [artifacts.sql, artifacts.question, sqlIsDirty, editedSql]);

  const handleDiscardCodeEdits = useCallback(() => {
    setEditedCode(artifacts.code);
    setRerunState({ kind: "idle" });
  }, [artifacts.code]);

  const handleDiscardSqlEdits = useCallback(() => {
    setEditedSql(artifacts.sql ?? "");
    setRerunState({ kind: "idle" });
  }, [artifacts.sql]);

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
    if (
      artifacts.results &&
      typeof artifacts.results === "object" &&
      Object.keys(artifacts.results).length > 0
    ) {
      const { columns, rows } = kvToTable(artifacts.results);
      sections.push({ title: "Results", columns, rows, name: "results" });
    }

    // Chart data
    if (artifacts.chart_data) {
      for (const [key, val] of Object.entries(artifacts.chart_data)) {
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
    if (artifacts.datasets) {
      for (const [key, val] of Object.entries(artifacts.datasets)) {
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
  }, [artifacts.results, artifacts.chart_data, artifacts.datasets]);

  const handleDownloadAll = useCallback(async () => {
    const sheets = dataSections.map((s) => ({
      name: s.name.slice(0, 31),
      headers: s.columns,
      rows: s.rows,
    }));
    if (sheets.length === 0) return;
    await downloadMultiSheetXlsx(sheets, sanitizeFilename(artifacts.question) + "_all");
  }, [dataSections, artifacts.question]);

  return (
    <div
      className="theme-card border border-border-default bg-surface-1 overflow-hidden"
      style={{ borderRadius: "var(--radius-card)", boxShadow: "var(--shadow-card)" }}
    >
      {/* Tab bar */}
      <div className="flex items-center border-b border-border-default">
        {artifacts.sql && (
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
        {artifacts.execution_ms > 0 && (
          <span className="ml-auto mr-4 text-xs text-t-tertiary">
            Executed in {(artifacts.execution_ms / 1000).toFixed(1)}s
          </span>
        )}
      </div>

      {/* SQL tab — editable when source is a warehouse and a parent rerun
          callback is wired up. Re-run executes against the warehouse,
          producing a fresh CSV → fresh Python code-gen → fresh dashboard. */}
      {tab === "sql" && artifacts.sql && (
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
              <span style={{ fontSize: 11, color: "#f87171", marginLeft: 4 }}>
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
              <span style={{ fontSize: 11, color: "#10b981", marginLeft: 4 }}>
                ✓ executed — see Data tab
              </span>
            )}
            {rerunState.kind === "error" && (
              <span style={{ fontSize: 11, color: "#f87171", marginLeft: 4 }}>
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
          />
          {!artifacts.sql && rerunState.kind === "idle" && csvId && (
            <p className="px-4 py-2 text-xs" style={{ color: "var(--color-surface-dark-text3)" }}>
              Tip: edit and Re-run to refresh the computed values shown in the Data tab. To rebuild
              the dashboard from new code, ask a follow-up question.
            </p>
          )}
        </div>
      )}

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
