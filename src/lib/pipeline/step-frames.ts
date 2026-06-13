/**
 * Step dataflow: expose an upstream investigation step's computed output as a
 * CSV file a dependent step's Python can load.
 *
 * Without this, every sub-question runs standalone over the source data and
 * `depends_on` is only a scheduling/ordering signal — a dependent can't
 * actually consume what its predecessor computed, and re-running a step only
 * revalidates its dependents rather than recomputing them with new inputs.
 *
 * With it, each dependent receives its predecessors' primary result tables as
 * `/data/step_<N>.csv` plus a prompt note, so the generated code can build on
 * them (`pd.read_csv("/data/step_2.csv")`). Re-running an upstream step and
 * then its dependents now flows the changed output downstream for real.
 */

import type { AdditionalFile } from "@/lib/sandbox";

export interface StepFrameSource {
  /** 1-based step number (matches the notebook + step_N namespace). */
  stepNo: number;
  datasets?: Record<string, Record<string, unknown>[]>;
  chart_data?: Record<string, unknown>;
}

export function stepFramePath(stepNo: number): string {
  return `/data/step_${stepNo}.csv`;
}

function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => esc(r[c])).join(","));
  return lines.join("\n");
}

/**
 * The most useful tabular output of a step: the largest dataset, falling back
 * to the largest array in chart_data. Scalars (results) aren't tabular and
 * aren't exposed as a frame.
 */
function primaryRows(
  src: StepFrameSource
): { name: string; rows: Record<string, unknown>[] } | null {
  const candidates: { name: string; rows: Record<string, unknown>[] }[] = [];
  for (const [name, rows] of Object.entries(src.datasets ?? {})) {
    if (Array.isArray(rows) && rows.length > 0 && typeof rows[0] === "object") {
      candidates.push({ name, rows: rows as Record<string, unknown>[] });
    }
  }
  for (const [name, val] of Object.entries(src.chart_data ?? {})) {
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === "object") {
      candidates.push({ name, rows: val as Record<string, unknown>[] });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.rows.length - a.rows.length);
  return candidates[0];
}

/**
 * Build sandbox input files + a prompt note from a dependent's upstream
 * sources. Returns empty when no source produced a tabular output.
 */
export function buildStepFrames(sources: StepFrameSource[]): {
  files: AdditionalFile[];
  context: string;
} {
  const files: AdditionalFile[] = [];
  const descs: string[] = [];
  for (const src of sources) {
    const primary = primaryRows(src);
    if (!primary) continue;
    files.push({ path: stepFramePath(src.stepNo), content: rowsToCsv(primary.rows) });
    descs.push(
      `- Step ${src.stepNo} ("${primary.name}", ${primary.rows.length} rows) → ${stepFramePath(
        src.stepNo
      )} (columns: ${Object.keys(primary.rows[0]).join(", ")})`
    );
  }
  if (files.length === 0) return { files: [], context: "" };
  return {
    files,
    context:
      `## Upstream step outputs (this sub-question depends on earlier steps)\n` +
      `The earlier steps you depend on already computed these result tables, available as CSV files:\n` +
      descs.join("\n") +
      `\n\nThis question BUILDS ON those steps. PREFER loading their output with pandas and using the exact entities/segments/thresholds they computed, rather than re-deriving the same thing from the raw source — this keeps the steps consistent and lets an edit to an upstream step flow through to this one. Re-derive from the raw source only for data the upstream output does not contain.\n` +
      `Example: \`prior = pd.read_csv("${stepFramePath(sources[0].stepNo)}")\`.`,
  };
}
