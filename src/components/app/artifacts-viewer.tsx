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

interface ArtifactsViewerProps {
  artifacts: CachedArtifacts;
}

type Tab = "code" | "data";

// Single-pass tokenizer for Python syntax highlighting.
// Avoids cascading regex issues by matching tokens in one pass —
// later patterns never see HTML inserted by earlier ones.
const KEYWORDS = new Set([
  "import",
  "from",
  "def",
  "class",
  "return",
  "if",
  "elif",
  "else",
  "for",
  "while",
  "try",
  "except",
  "finally",
  "with",
  "as",
  "in",
  "not",
  "and",
  "or",
  "is",
  "None",
  "True",
  "False",
  "lambda",
  "yield",
  "raise",
  "pass",
  "break",
  "continue",
  "async",
  "await",
]);
const BUILTINS = new Set([
  "print",
  "len",
  "range",
  "int",
  "float",
  "str",
  "list",
  "dict",
  "set",
  "tuple",
  "type",
  "isinstance",
  "enumerate",
  "zip",
  "map",
  "filter",
  "sorted",
  "sum",
  "min",
  "max",
  "abs",
  "round",
  "open",
]);

// Order matters: earlier alternatives are tried first.
const TOKEN_RE =
  /"""[\s\S]*?"""|'''[\s\S]*?'''|#[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[a-zA-Z_]\w*|\d+\.?\d*(?:[eE][+-]?\d+)?|[\s\S]/g;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function highlightPython(code: string): string {
  return Array.from(code.matchAll(TOKEN_RE))
    .map(([tok]) => {
      // Comments
      if (tok.startsWith("#")) {
        return `<span style="color:var(--syntax-comment);font-style:italic">${esc(tok)}</span>`;
      }
      // Strings (single, double, triple-quoted)
      if (
        tok.startsWith('"') ||
        tok.startsWith("'") ||
        tok.startsWith('"""') ||
        tok.startsWith("'''")
      ) {
        return `<span style="color:var(--syntax-string)">${esc(tok)}</span>`;
      }
      // Identifiers: keywords vs builtins vs plain
      if (/^[a-zA-Z_]/.test(tok)) {
        if (KEYWORDS.has(tok)) {
          return `<span style="color:var(--syntax-keyword);font-weight:600">${esc(tok)}</span>`;
        }
        if (BUILTINS.has(tok)) {
          return `<span style="color:var(--syntax-builtin)">${esc(tok)}</span>`;
        }
        return esc(tok);
      }
      // Numbers
      if (/^\d/.test(tok)) {
        return `<span style="color:var(--syntax-number)">${esc(tok)}</span>`;
      }
      return esc(tok);
    })
    .join("");
}

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

export function ArtifactsViewer({ artifacts }: ArtifactsViewerProps) {
  const [tab, setTab] = useState<Tab>("code");
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(artifacts.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [artifacts.code]);

  const handleDownloadPy = useCallback(() => {
    downloadCodeAsFile(artifacts.code, `${sanitizeFilename(artifacts.question)}.py`);
  }, [artifacts.code, artifacts.question]);

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

  const lines = artifacts.code.split("\n");

  return (
    <div
      className="theme-card border border-border-default bg-surface-1 overflow-hidden"
      style={{ borderRadius: "var(--radius-card)", boxShadow: "var(--shadow-card)" }}
    >
      {/* Tab bar */}
      <div className="flex items-center border-b border-border-default">
        <button
          onClick={() => setTab("code")}
          className={`px-4 py-2 text-sm font-medium transition-colors ${
            tab === "code"
              ? "border-b-2 border-accent text-accent"
              : "text-t-secondary hover:text-t-primary"
          }`}
          style={{ transitionDuration: "var(--transition-speed)" }}
        >
          Code
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

      {/* Code tab */}
      {tab === "code" && (
        <div>
          <div className="flex items-center gap-2 border-b border-table-divider px-4 py-2">
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
          </div>
          <div className="overflow-x-auto p-4">
            <div className="flex text-xs leading-5">
              <div className="select-none pr-4 text-right text-t-tertiary">
                {lines.map((_, i) => (
                  <div key={i}>{i + 1}</div>
                ))}
              </div>
              <pre className="flex-1">
                <code
                  dangerouslySetInnerHTML={{
                    __html: highlightPython(artifacts.code),
                  }}
                />
              </pre>
            </div>
          </div>
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
