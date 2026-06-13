/**
 * Assemble an Investigate notebook into a portable Markdown document:
 * title, approach, then each cell in notebook-layout order — user markdown
 * cells verbatim, and per step: question, SQL, Python, the step's insight
 * (lifted from its composed cell), a data preview table, and status notes —
 * closing with the synthesis (summary, conclusion, grounding verdict).
 *
 * Pure + dependency-free so it runs client-side from the cached trail.
 */

import type { Spec } from "@json-render/core";
import type { InvestigationTrace, TraceStep } from "@/lib/pipeline/investigation-trace";

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
