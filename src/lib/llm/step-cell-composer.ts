/**
 * Per-step cell composer for notebook mode.
 *
 * The unified investigate composer waits for ALL steps and produces one
 * dashboard spec. Notebook mode instead renders each step as a cell that
 * fills in the moment its step finishes — so each successful step gets its
 * own small LLM compose, dispatched concurrently with the next wave's
 * execution (the compose latency hides behind sandbox time).
 *
 * The LLM emits the same JSONL patch protocol as every other composer in
 * this codebase; we assemble the patches into a complete `Spec` server-side
 * (placeholders resolved against the step's OWN unprefixed namespace) and
 * return it. The assembled spec is streamed to the client as
 * `/state/__cells/{index}` and persisted on `TraceStep.cellSpec`, so
 * notebooks reload from history for free.
 *
 * Posture: best-effort, same as the gap-check. A failed cell compose
 * returns null — the notebook falls back to a stub for that cell; the
 * unified dashboard compose is unaffected.
 */

import { generateText } from "ai";
import { applySpecPatch, parseSpecStreamLine, type Spec } from "@/spec/core";
import { getModel, cachedSystem } from "@/lib/llm/client";
import { catalog } from "@/lib/catalog";
import { describeShape, describeResultsSchema } from "@/lib/llm/investigate-composer";
import { unwrapScalar } from "@/lib/llm/resolve-placeholders";
import { createSpecFinalizer } from "@/lib/llm/finalize-spec-stream";
import { UI_COMPOSE_MODEL } from "@/lib/constants";
import { logger } from "@/lib/logger";

const CELL_SYSTEM_PROMPT = `You compose ONE compact notebook cell visualizing the result of a single investigation step. The cell appears in a notebook where the step's question, status, and code are already shown by the surrounding chrome — your job is ONLY the output area.

Output format: streaming JSONL patches that build a JSON-Render spec. Output ONLY raw JSONL lines, no markdown fencing.

## Cell structure
- Root: a LayoutColumn.
- 1-2 visualizations that fit the chart_data shape (bar for categories, line for trends, stat cards in a LayoutGrid for top-line numbers, table for detail). Prefer ONE chart unless the data clearly warrants two.
- ONE TextBlock (variant: insight) with 1-2 sentences interpreting THIS step's finding.
- HARD CAP: 6 components total. No heading, no SectionBreak, no title block — the notebook chrome already shows the question.
- If the step is marked DEGRADED, additionally render an Annotation (severity: info) noting the validator's concern; the data MAY still be correct.

## Data rules
- Keys are UNPREFIXED — reference them exactly as given: "$result:<key>" for scalars, "$chartData:<key>" for chart data props.
- Placeholders are JSON STRING values. Write "value": "$result:total_revenue" and "data": "$chartData:monthly_trend". NEVER use object form — {"$result": "total_revenue"} and {"$chartData": "monthly_trend"} are WRONG and will not resolve.
- Every key in the Results Schema is a SCALAR — safe for StatCard values and inline prose.
- NEVER write a literal number in prose. Every figure in the insight MUST be a $result:<key> placeholder. If a number can't be expressed as a placeholder, describe it qualitatively instead.
- No step citations — this cell IS the step.`;

/**
 * Flatten a step's results into SCALAR leaf entries with placeholder-safe
 * key names (`[a-zA-Z0-9_]` only). Two failure modes this prevents, both
 * observed in real cell composes:
 *
 *   1. A StatCard bound to a nested-object key renders "[object Object]" —
 *      flattened, only scalar keys are offered to the LLM.
 *   2. Keys containing spaces ("region_summaries.Asia Pacific.growth") can
 *      never resolve as INLINE prose placeholders (the inline regex stops
 *      at whitespace) — sanitized keys are always regex-safe.
 *
 * Wrapped scalars ({value, format, label, ...}) are unwrapped rather than
 * exploded. Short scalar arrays are kept (useful in prose); row-like arrays
 * are dropped — chart_data covers those.
 */
export function flattenResultScalars(
  results: Record<string, unknown>,
  prefix = "",
  out: Record<string, unknown> = {},
  depth = 0
): Record<string, unknown> {
  if (depth > 5) return out;
  for (const [k, v] of Object.entries(results)) {
    const safe = k.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    if (!safe) continue;
    const key = prefix ? `${prefix}_${safe}` : safe;
    const unwrapped = unwrapScalar(v);
    if (
      unwrapped === null ||
      typeof unwrapped === "number" ||
      typeof unwrapped === "string" ||
      typeof unwrapped === "boolean"
    ) {
      out[key] = unwrapped;
    } else if (Array.isArray(unwrapped)) {
      if (unwrapped.length <= 8 && unwrapped.every((x) => typeof x !== "object" || x === null)) {
        out[key] = unwrapped;
      }
    } else if (typeof unwrapped === "object") {
      flattenResultScalars(unwrapped as Record<string, unknown>, key, out, depth + 1);
    }
  }
  return out;
}

export interface ComposeStepCellArgs {
  stepNo: number;
  question: string;
  rationale: string;
  originalQuestion: string;
  approach: string;
  results: Record<string, unknown>;
  chartData: Record<string, unknown>;
  degraded?: boolean;
  degradedReason?: string;
  uiComposeModel?: string;
}

function buildCellUserPrompt(args: ComposeStepCellArgs): string {
  const degradedBlock = args.degraded
    ? `\n## DEGRADED\nThe result validator flagged this step: ${(args.degradedReason ?? "suspicious result").slice(0, 300)}\nRender the visualization anyway, plus an Annotation (severity: info) with the concern.`
    : "";

  const chartDataShape = Object.fromEntries(
    Object.entries(args.chartData).map(([k, v]) => [k, describeShape(v)])
  );

  return `## Investigation context (for framing only — do not render it)
Original question: ${args.originalQuestion}
Approach: ${args.approach}

## This step (Step ${args.stepNo})
Question: ${args.question}
Rationale: ${args.rationale}${degradedBlock}

## Results Schema
${JSON.stringify(describeResultsSchema(args.results))}

Use "$result:<key>" for scalar values.

## Chart Data Shapes
${JSON.stringify(chartDataShape, null, 2)}

Use "$chartData:<key>" for chart data props.

Compose the cell. Output ONLY raw JSONL patches.`;
}

/**
 * Assemble raw composer output (JSONL patch lines) into a complete Spec,
 * resolving $result/$chartData placeholders against the step's own
 * namespace. Returns null when the output doesn't yield a renderable spec.
 * Exported separately from the LLM call for unit testing.
 */
export function assembleCellSpec(
  raw: string,
  results: Record<string, unknown>,
  chartData: Record<string, unknown>
): Spec | null {
  const spec: Spec = { root: "", elements: {} };
  let applied = 0;
  const finalize = createSpecFinalizer({ results, chartData });
  for (const line of raw.split("\n")) {
    const r = finalize(line);
    if (r.skip) continue;
    const patch = parseSpecStreamLine(r.line);
    if (!patch) continue;
    try {
      applySpecPatch(spec, patch);
      applied++;
    } catch {
      // Skip malformed patches; assembly is best-effort.
    }
  }
  if (!spec.root || applied === 0 || Object.keys(spec.elements).length === 0) {
    return null;
  }
  return spec;
}

/**
 * Compose a notebook cell for one completed step. Best-effort: returns null
 * on any LLM or assembly failure.
 */
export async function composeStepCell(args: ComposeStepCellArgs): Promise<Spec | null> {
  const model = getModel(args.uiComposeModel ?? UI_COMPOSE_MODEL);
  // Offer the LLM only flattened scalar result keys (placeholder-safe names,
  // no nested objects) and resolve against the same map.
  const flatArgs = { ...args, results: flattenResultScalars(args.results) };
  try {
    const result = await generateText({
      model,
      system: cachedSystem(catalog.prompt({ customRules: [CELL_SYSTEM_PROMPT] })),
      prompt: buildCellUserPrompt(flatArgs),
      temperature: 0.2,
      maxOutputTokens: 8_000, // a cell is ≤6 components; data arrives via placeholders
    });
    const spec = assembleCellSpec(result.text, flatArgs.results, flatArgs.chartData);
    if (!spec) {
      logger.warn("Step-cell compose produced no renderable spec", { stepNo: args.stepNo });
    }
    return spec;
  } catch (err) {
    logger.warn("Step-cell compose failed", {
      stepNo: args.stepNo,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
