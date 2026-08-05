/**
 * Assemble an Investigate notebook into a portable Markdown document:
 * title, approach, then each cell in notebook-layout order — user markdown
 * cells verbatim, and per step: question, SQL, Python, the step's insight
 * (lifted from its composed cell), a data preview table, and status notes —
 * closing with the synthesis (summary, conclusion, grounding verdict).
 *
 * Pure + dependency-free so it runs client-side from the cached trail.
 */

import type { Spec } from "@/spec/core";
import type { InvestigationTrace, TraceStep } from "@/lib/pipeline/investigation-trace";
import { escapeHtml } from "@/lib/format";

export interface NotebookSynthesis {
  summary?: string;
  conclusion?: string;
}

const MAX_TABLE_ROWS = 20;

/** Lift the narrative text (TextBlock / Annotation content) from a cell spec. */
function cellNarrative(spec: Spec | undefined): string[] {
  if (!spec?.elements) return [];
  const out: string[] = [];
  for (const el of Object.values(spec.elements)) {
    const node = el as { type?: string; props?: Record<string, unknown> };
    if (node.type === "TextBlock" && typeof node.props?.content === "string") {
      out.push(node.props.content);
    } else if (node.type === "Annotation") {
      const title = typeof node.props?.title === "string" ? node.props.title : "";
      const content = typeof node.props?.content === "string" ? node.props.content : "";
      const joined = [title, content].filter(Boolean).join(": ");
      if (joined) out.push(`> ${joined}`);
    }
  }
  return out;
}

/** The step's primary tabular output (largest dataset, else chart_data array). */
function primaryTable(step: TraceStep): { cols: string[]; rows: Record<string, unknown>[] } | null {
  const candidates: Record<string, unknown>[][] = [];
  for (const rows of Object.values(step.datasets ?? {})) {
    if (Array.isArray(rows) && rows.length > 0 && typeof rows[0] === "object")
      candidates.push(rows);
  }
  for (const val of Object.values(step.chart_data ?? {})) {
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object") {
      candidates.push(val as Record<string, unknown>[]);
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.length - a.length);
  const rows = candidates[0];
  return { cols: Object.keys(rows[0]), rows };
}

function mdCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function tableToMarkdown(cols: string[], rows: Record<string, unknown>[]): string {
  const head = `| ${cols.join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows
    .slice(0, MAX_TABLE_ROWS)
    .map((r) => `| ${cols.map((c) => mdCell(r[c])).join(" | ")} |`)
    .join("\n");
  const more =
    rows.length > MAX_TABLE_ROWS ? `\n\n_…${rows.length - MAX_TABLE_ROWS} more rows_` : "";
  return `${head}\n${sep}\n${body}${more}`;
}

function stepSection(step: TraceStep): string {
  const parts: string[] = [`## Step ${step.stepNo} — ${step.question}`];
  if (step.rationale) parts.push(`_${step.rationale}_`);

  if (step.status === "removed") {
    parts.push("> Dropped by the re-planner.");
    return parts.join("\n\n");
  }
  if (step.status === "failed") {
    parts.push(`> **Failed:** ${step.error ?? "execution error"}`);
    return parts.join("\n\n");
  }
  if (step.status === "degraded" && step.degradedReason) {
    parts.push(`> **Validator note:** ${step.degradedReason}`);
  }
  if (step.sql) parts.push("```sql\n" + step.sql.trim() + "\n```");
  if (step.code) parts.push("```python\n" + step.code.trim() + "\n```");

  const narrative = cellNarrative(step.cellSpec);
  if (narrative.length) parts.push(narrative.join("\n\n"));

  const table = primaryTable(step);
  if (table) parts.push(tableToMarkdown(table.cols, table.rows));

  return parts.join("\n\n");
}

/** Order steps + user markdown cells per the saved notebook layout. */
function orderedBlocks(trace: InvestigationTrace): { markdown?: string; step?: TraceStep }[] {
  const byNo = new Map(trace.steps.map((s) => [s.stepNo, s]));
  const used = new Set<number>();
  const out: { markdown?: string; step?: TraceStep }[] = [];
  for (const lc of trace.notebook?.cells ?? []) {
    if (lc.kind === "markdown") {
      out.push({ markdown: lc.content });
    } else if (!used.has(lc.stepNo)) {
      const s = byNo.get(lc.stepNo);
      if (s) {
        out.push({ step: s });
        used.add(lc.stepNo);
      }
    }
  }
  for (const s of trace.steps) if (!used.has(s.stepNo)) out.push({ step: s });
  return out;
}

// ── HTML export ───────────────────────────────────────────────────────

/** Minimal inline markdown → HTML (bold, italic, code) on an escaped string. */
function inlineMd(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

/** Minimal block markdown → HTML (headings, lists, paragraphs). */
function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inlineMd(para.join(" "))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? "ol" : "ul";
      out.push(`<${tag}>${list.items.map((i) => `<li>${inlineMd(i)}</li>`).join("")}</${tag}>`);
      list = null;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const bullet = line.match(/^[-*]\s+(.*)$/);
    const ordered = line.match(/^\d+\.\s+(.*)$/);
    if (heading) {
      flushPara();
      flushList();
      out.push(`<h${heading[1].length}>${inlineMd(heading[2])}</h${heading[1].length}>`);
    } else if (bullet) {
      flushPara();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(bullet[1]);
    } else if (ordered) {
      flushPara();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ordered[1]);
    } else if (line.trim() === "") {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join("\n");
}

function tableToHtml(cols: string[], rows: Record<string, unknown>[]): string {
  const head = `<thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead>`;
  const body = rows
    .slice(0, MAX_TABLE_ROWS)
    .map(
      (r) =>
        `<tr>${cols
          .map((c) => {
            const v = r[c];
            const s =
              v === null || v === undefined
                ? ""
                : typeof v === "object"
                  ? JSON.stringify(v)
                  : String(v);
            return `<td>${escapeHtml(s)}</td>`;
          })
          .join("")}</tr>`
    )
    .join("");
  const more =
    rows.length > MAX_TABLE_ROWS
      ? `<p class="muted">…${rows.length - MAX_TABLE_ROWS} more rows</p>`
      : "";
  return `<table>${head}<tbody>${body}</tbody></table>${more}`;
}

const HTML_STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; background: #f6f7f9; color: #1a1d21;
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.wrap { max-width: 880px; margin: 0 auto; padding: 40px 24px 80px; }
h1 { font-size: 26px; line-height: 1.25; margin: 0 0 8px; }
h2 { font-size: 19px; margin: 0 0 4px; }
h3 { font-size: 16px; }
.approach { color: #5b6470; margin: 0 0 28px; }
.cell { background: #fff; border: 1px solid #e3e6ea; border-radius: 12px;
  padding: 18px 20px; margin: 16px 0; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
.badge { display: inline-block; font-size: 11px; font-weight: 600; text-transform: uppercase;
  letter-spacing: .04em; color: #3b6ef0; background: #eef2ff; padding: 2px 8px; border-radius: 6px; }
.rationale { color: #717a86; font-size: 13px; margin: 4px 0 12px; }
pre { background: #1e2127; color: #e6e6e6; border-radius: 8px; padding: 12px 14px; overflow: auto;
  font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; margin: 10px 0; }
pre.sql { background: #14233a; }
code { background: #eef0f3; padding: 1px 5px; border-radius: 4px;
  font: .9em ui-monospace, SFMono-Regular, Menlo, monospace; }
pre code { background: none; padding: 0; }
img.chart { max-width: 100%; height: auto; border: 1px solid #eef0f3; border-radius: 8px; margin: 10px 0; }
table { border-collapse: collapse; width: 100%; margin: 10px 0; font-size: 13px; }
th, td { border: 1px solid #e3e6ea; padding: 5px 9px; text-align: left; white-space: nowrap; }
th { background: #f2f4f7; }
.insight { border-left: 3px solid #3b6ef0; padding-left: 12px; color: #2b3b5a; margin: 10px 0; }
.note { background: #fff8e6; border: 1px solid #f0d98a; color: #8a6d1a; padding: 8px 12px; border-radius: 8px; margin: 10px 0; font-size: 13px; }
.note.err { background: #fdeded; border-color: #f0a8a8; color: #9a2a2a; }
.synthesis { border: 1px solid #c9d6ff; }
.muted { color: #8b94a0; font-size: 12px; }
.footer { color: #9aa3af; font-size: 12px; margin-top: 32px; }
details { margin: 10px 0; }
summary { cursor: pointer; font-size: 13px; font-weight: 600; color: #5b6470; }
`.trim();

function stepSectionHtml(step: TraceStep, chartUri?: string): string {
  const parts: string[] = [
    `<div class="cell">`,
    `<span class="badge">Step ${step.stepNo}</span>`,
    `<h2>${escapeHtml(step.question)}</h2>`,
  ];
  if (step.rationale) parts.push(`<p class="rationale">${escapeHtml(step.rationale)}</p>`);

  if (step.status === "removed") {
    parts.push(`<div class="note">Dropped by the re-planner.</div></div>`);
    return parts.join("\n");
  }
  if (step.status === "failed") {
    parts.push(
      `<div class="note err">Failed: ${escapeHtml(step.error ?? "execution error")}</div></div>`
    );
    return parts.join("\n");
  }
  if (step.status === "degraded" && step.degradedReason) {
    parts.push(`<div class="note">Validator note: ${escapeHtml(step.degradedReason)}</div>`);
  }
  if (step.sql)
    parts.push(
      `<details><summary>SQL</summary><pre class="sql"><code>${escapeHtml(step.sql.trim())}</code></pre></details>`
    );
  if (step.code)
    parts.push(
      `<details><summary>Python</summary><pre><code>${escapeHtml(step.code.trim())}</code></pre></details>`
    );
  if (chartUri)
    parts.push(`<img class="chart" src="${chartUri}" alt="Step ${step.stepNo} visualization" />`);
  for (const n of cellNarrative(step.cellSpec))
    parts.push(`<div class="insight">${inlineMd(n)}</div>`);
  const table = primaryTable(step);
  if (table)
    parts.push(
      `<details><summary>Data (${table.rows.length} rows)</summary>${tableToHtml(table.cols, table.rows)}</details>`
    );
  parts.push(`</div>`);
  return parts.join("\n");
}

/**
 * Build a fully self-contained HTML document (inlined CSS + base64 chart
 * images) — droppable on S3 / Drive and served as-is. `chartImages` maps a
 * step number to a PNG data URI captured from the rendered cell output.
 */
export function buildNotebookHtml(
  trace: InvestigationTrace,
  synthesis?: NotebookSynthesis,
  chartImages?: Map<number, string>
): string {
  const body: string[] = [`<h1>${escapeHtml(trace.originalQuestion)}</h1>`];
  if (trace.approach) body.push(`<p class="approach">${escapeHtml(trace.approach)}</p>`);

  for (const b of orderedBlocks(trace)) {
    if (b.markdown !== undefined) {
      if (b.markdown.trim())
        body.push(`<div class="cell">${markdownToHtml(b.markdown.trim())}</div>`);
    } else if (b.step) {
      body.push(stepSectionHtml(b.step, chartImages?.get(b.step.stepNo)));
    }
  }

  const summary = synthesis?.summary?.trim();
  const conclusion = synthesis?.conclusion?.trim();
  if (summary || conclusion || trace.grounding) {
    const s: string[] = [`<div class="cell synthesis"><span class="badge">Synthesis</span>`];
    if (summary) s.push(`<div class="insight">${inlineMd(summary)}</div>`);
    if (conclusion) s.push(`<p>${inlineMd(conclusion)}</p>`);
    if (trace.grounding) {
      const g = trace.grounding;
      s.push(
        g.ok
          ? `<p class="muted">✓ ${g.checkedCount} figure(s) trace to a computed result.</p>`
          : `<p class="note">▲ Unverified figures: ${escapeHtml(g.ungrounded.join(", "))}.</p>`
      );
    }
    s.push(`</div>`);
    body.push(s.join("\n"));
  }

  body.push(`<p class="footer">Generated by Hermetic.</p>`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(trace.originalQuestion || "Notebook")}</title>
<style>${HTML_STYLE}</style>
</head>
<body><div class="wrap">
${body.join("\n")}
</div></body>
</html>`;
}

export function buildNotebookMarkdown(
  trace: InvestigationTrace,
  synthesis?: NotebookSynthesis
): string {
  const blocks: string[] = [`# ${trace.originalQuestion}`];
  if (trace.approach) blocks.push(`**Approach:** ${trace.approach}`);

  for (const b of orderedBlocks(trace)) {
    if (b.markdown !== undefined) {
      if (b.markdown.trim()) blocks.push(b.markdown.trim());
    } else if (b.step) {
      blocks.push(stepSection(b.step));
    }
  }

  const summary = synthesis?.summary?.trim();
  const conclusion = synthesis?.conclusion?.trim();
  if (summary || conclusion) {
    const synthParts = ["## Synthesis"];
    if (summary) synthParts.push(summary);
    if (conclusion) synthParts.push(conclusion);
    blocks.push(synthParts.join("\n\n"));
  }
  if (trace.grounding) {
    const g = trace.grounding;
    blocks.push(
      g.ok
        ? `_✓ ${g.checkedCount} figure(s) in the narrative trace to a computed result._`
        : `_▲ Unverified figures: ${g.ungrounded.join(", ")}._`
    );
  }

  return blocks.join("\n\n") + "\n";
}
