/**
 * Investigate composer — takes the plan + each sub-question's pipeline
 * results and synthesizes a unified JSON-Render dashboard spec.
 *
 * The composer makes ONE LLM call that produces the full spec, structured
 * as: executive summary at top → SectionBreak between sub-question
 * sections → each section has a sub-heading + the relevant components for
 * that sub-question's data. Failed sub-questions are surfaced as
 * Annotations explaining the gap rather than silently dropped.
 *
 * Data merging:
 *
 * Per-sub-question artifacts (results, chart_data) are flattened into a
 * single namespace with `step_<N>_` prefixes. The LLM sees all of it in
 * one context window. For each section the LLM is told which step number
 * to reference (e.g. `$result:step_2_total_revenue`).
 */

import { streamText } from "ai";
import { getModel } from "@/lib/llm/client";
import { catalog } from "@/lib/catalog";
import { UI_COMPOSE_MODEL, LLM_MAX_OUTPUT_TOKENS } from "@/lib/constants";
import type { CSVSchema } from "@/lib/types";
import type { SubQuestionResult } from "@/lib/pipeline/investigate-orchestrator";
import type { InvestigationPlan } from "@/lib/llm/investigate-planner";
import { logger } from "@/lib/logger";

// ── Helpers (mirrors the inline ones in /api/query/route.ts) ─────────

function describeShape(val: unknown): unknown {
  if (Array.isArray(val)) {
    if (val.length === 0) return { _type: "array", rows: 0 };
    const first = val[0];
    if (typeof first === "object" && first !== null) {
      const cols: Record<string, string> = {};
      for (const [k, v] of Object.entries(first)) {
        cols[k] = typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string";
      }
      return { _type: "array", rows: val.length, columns: cols };
    }
    return { _type: "array", rows: val.length, valueType: typeof first };
  }
  if (typeof val === "object" && val !== null) {
    const described: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) described[k] = describeShape(v);
    return described;
  }
  return val;
}

function describeResultsSchema(obj: Record<string, unknown>): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) {
      schema[key] = { type: "null" };
    } else if (typeof val === "number") {
      schema[key] = { type: "number", is_integer: Number.isInteger(val) };
    } else if (typeof val === "boolean") {
      schema[key] = { type: "boolean" };
    } else if (typeof val === "string") {
      schema[key] = { type: "string" };
    } else if (Array.isArray(val)) {
      schema[key] = {
        type: "array",
        length: val.length,
        element_type: val.length > 0 ? typeof val[0] : "unknown",
      };
    } else if (typeof val === "object") {
      schema[key] = {
        type: "object",
        keys: describeResultsSchema(val as Record<string, unknown>),
      };
    }
  }
  return schema;
}

function truncateValue(val: unknown, maxChars: number): unknown {
  if (Array.isArray(val)) {
    for (let limit = Math.min(val.length, 50); limit >= 5; limit = Math.floor(limit / 2)) {
      const sliced = val.slice(0, limit);
      const json = JSON.stringify(sliced);
      if (json.length <= maxChars) {
        if (limit < val.length) return { _truncated: true, _total: val.length, _sample: sliced };
        return sliced;
      }
    }
    return { _truncated: true, _total: val.length, _sample: val.slice(0, 3) };
  }
  const json = JSON.stringify(val);
  if (json.length <= maxChars) return val;
  if (typeof val === "object" && val !== null) {
    const entries = Object.entries(val as Record<string, unknown>);
    const trimmed: Record<string, unknown> = {};
    let remaining = maxChars - 50;
    for (const [k, v] of entries) {
      const s = JSON.stringify(v);
      if (s.length <= remaining) {
        trimmed[k] = v;
        remaining -= s.length;
      } else {
        trimmed[k] = truncateValue(v, Math.max(remaining, 200));
        break;
      }
    }
    return trimmed;
  }
  return String(val).slice(0, maxChars);
}

// ── Per-step namespace + flatten ──────────────────────────────────────

function flattenStepArtifacts(subResults: SubQuestionResult[]): {
  mergedResults: Record<string, unknown>;
  mergedChartData: Record<string, unknown>;
  perStepMetadata: {
    index: number;
    question: string;
    rationale: string;
    failed: boolean;
    degraded: boolean;
    removed: boolean;
    error?: string;
    degradedReason?: string;
    resultKeys: string[];
    chartDataKeys: string[];
  }[];
} {
  const mergedResults: Record<string, unknown> = {};
  const mergedChartData: Record<string, unknown> = {};
  const perStepMetadata: ReturnType<typeof flattenStepArtifacts>["perStepMetadata"] = [];

  for (const sub of subResults) {
    // Sub-questions the re-planner dropped are not rendered in the dashboard —
    // they never ran and have no data to show.
    if (sub.removed) continue;
    const stepNo = sub.index + 1; // 1-indexed for human readability
    const prefix = `step_${stepNo}_`;
    const meta = {
      index: sub.index,
      question: sub.question,
      rationale: sub.rationale,
      failed: !!sub.error,
      degraded: !!sub.degraded,
      removed: false,
      error: sub.error,
      degradedReason: sub.degradedReason,
      resultKeys: [] as string[],
      chartDataKeys: [] as string[],
    };

    if (sub.result) {
      const exec = sub.result.executionResult;
      for (const [k, v] of Object.entries(exec.results)) {
        const namespaced = `${prefix}${k}`;
        mergedResults[namespaced] = v;
        meta.resultKeys.push(namespaced);
      }
      for (const [k, v] of Object.entries(exec.chart_data)) {
        const namespaced = `${prefix}${k}`;
        mergedChartData[namespaced] = v;
        meta.chartDataKeys.push(namespaced);
      }
    }
    perStepMetadata.push(meta);
  }

  return { mergedResults, mergedChartData, perStepMetadata };
}

// ── Prompt construction ──────────────────────────────────────────────

function buildComposerSystemPrompt(): string {
  return `You compose a unified data-analysis dashboard from the results of an INVESTIGATION — a multi-step analysis where each step answered one focused sub-question.

Output format: streaming JSONL patches that build a JSON-Render spec, exactly the same as the standard dashboard composition. Output ONLY raw JSONL lines, no markdown fencing.

## Investigation dashboard structure
Wrap everything in a LayoutColumn root. Then produce, in order:

1. **Title block** — a TextBlock (variant: heading) with the original user question.
2. **Executive summary** — a TextBlock (variant: insight) with 2-4 sentences synthesizing what the investigation found across all steps. Use $result placeholders for any numbers you cite.
3. **Section per successful step** — for each successful sub-question:
   - A SectionBreak with the variant: line and the step heading as label (e.g. "Step 2 — Where did the decline originate?")
   - A TextBlock (variant: heading) restating the sub-question
   - The visualization(s) for that step's data (bar chart, line chart, stat cards, table — pick what fits the chart_data shape)
   - A TextBlock (variant: insight) with 1-2 sentences interpreting THIS step's finding specifically
4. **Failed steps** — for any sub-question that failed, render an Annotation (severity: warning) noting the question and the failure reason. Do NOT skip them silently.
5. **Degraded steps** — for any sub-question marked DEGRADED, still render its visualization but ALSO add an Annotation (severity: info) above it noting the validator's concern ("empty result", "all-zero values", etc.). The number / chart MAY be correct; the validator just flagged it as suspicious.
6. **Conclusion** — a TextBlock (variant: body) with implications and recommended next steps.

## Component & data rules
- Each step's data is namespaced with prefix \`step_<N>_\` where N is 1-based. Reference it like "$result:step_2_total_revenue" or "$chartData:step_2_bar_data".
- Use the EXACT key names provided in the data shapes — case-sensitive, fully prefixed.
- Use stat cards for top-line numbers, bar charts for category comparisons, line charts for trends, treemap/sunburst for hierarchies.
- Keep total component count under 30 (this is a longer dashboard than a single Ask but should still be readable).
- Never fabricate numbers — every numeric display MUST come from a $result:step_N_<key> placeholder.

## Tone for narrative blocks
- Title heading: just the original question, capitalized.
- Executive summary: lead with the bottom-line finding. Be specific. No buzzwords.
- Per-step insights: focus on what THAT step revealed — the executive summary already gave the big picture.
- Conclusion: 2-3 sentences. What the user should do or investigate next.`;
}

function buildComposerUserPrompt(args: {
  originalQuestion: string;
  plan: InvestigationPlan;
  schema: CSVSchema;
  perStepMetadata: ReturnType<typeof flattenStepArtifacts>["perStepMetadata"];
  mergedResults: Record<string, unknown>;
  mergedChartData: Record<string, unknown>;
}): string {
  const stepBlocks = args.perStepMetadata
    .map((m) => {
      const stepNo = m.index + 1;
      if (m.failed) {
        return `### Step ${stepNo} — FAILED
Question: ${m.question}
Rationale: ${m.rationale}
Error: ${(m.error ?? "").slice(0, 300)}`;
      }
      const degradedTag = m.degraded ? " — DEGRADED" : "";
      const degradedNote = m.degraded
        ? `\nDegraded: ${(m.degradedReason ?? "validator flagged this result").slice(0, 300)}`
        : "";
      return `### Step ${stepNo}${degradedTag}
Question: ${m.question}
Rationale: ${m.rationale}${degradedNote}
Result keys: ${m.resultKeys.join(", ") || "(none)"}
Chart data keys: ${m.chartDataKeys.join(", ") || "(none)"}`;
    })
    .join("\n\n");

  // Cap merged results at 40K chars total (keeps us under context limits even for verbose investigations)
  const compactResults = truncateValue(args.mergedResults, 40_000);
  const resultsSchema = describeResultsSchema(compactResults as Record<string, unknown>);
  const chartDataShape = Object.fromEntries(
    Object.entries(args.mergedChartData).map(([k, v]) => [k, describeShape(v)])
  );

  return `## Original Question
${args.originalQuestion}

## Approach
${args.plan.approach}

## Steps
${stepBlocks}

## Results Schema (across all steps)
${JSON.stringify(resultsSchema)}

Use "$result:<key>" for scalar values in StatCard / TextBlock / TrendIndicator. Keys are prefixed with step_N_.

## Chart Data Shapes (across all steps)
${JSON.stringify(chartDataShape, null, 2)}

Use "$chartData:<key>" for chart data props. Keys are prefixed with step_N_.

Compose the unified investigation dashboard following the rules in the system prompt. Output ONLY raw JSONL patches.`;
}

// ── Public entry point ───────────────────────────────────────────────

export interface ComposeArgs {
  originalQuestion: string;
  plan: InvestigationPlan;
  schema: CSVSchema;
  subResults: SubQuestionResult[];
  uiComposeModel?: string;
}

export interface ComposeStreamOutput {
  /** Async-iterable text stream from the LLM. Caller pipes to client. */
  textStream: AsyncIterable<string>;
  /** Initial-state injection: merged datasets/chart_data the spec references. */
  initialState: {
    chart_data: Record<string, unknown>;
    results: Record<string, unknown>;
    /** Plan metadata for client-side display. */
    investigation: {
      approach: string;
      steps: {
        index: number;
        question: string;
        rationale: string;
        failed: boolean;
        degraded: boolean;
      }[];
    };
  };
}

/**
 * Begin streaming the composed investigation dashboard. The caller is
 * responsible for piping `textStream` to the client and injecting
 * `initialState` into the spec's state on first patch (mirrors how
 * /api/query streams its base state).
 */
export function composeInvestigation(args: ComposeArgs): ComposeStreamOutput {
  const { mergedResults, mergedChartData, perStepMetadata } = flattenStepArtifacts(args.subResults);

  const model = getModel(args.uiComposeModel ?? UI_COMPOSE_MODEL);

  const systemPrompt = buildComposerSystemPrompt();
  const userPrompt = buildComposerUserPrompt({
    originalQuestion: args.originalQuestion,
    plan: args.plan,
    schema: args.schema,
    perStepMetadata,
    mergedResults,
    mergedChartData,
  });

  logger.info("Investigate: composing dashboard", {
    successfulSteps: perStepMetadata.filter((m) => !m.failed && !m.degraded).length,
    degradedSteps: perStepMetadata.filter((m) => m.degraded).length,
    failedSteps: perStepMetadata.filter((m) => m.failed).length,
    resultKeys: Object.keys(mergedResults).length,
    chartDataKeys: Object.keys(mergedChartData).length,
  });

  const result = streamText({
    model,
    system: catalog.prompt({ customRules: [systemPrompt] }),
    prompt: userPrompt,
    temperature: 0.2,
    maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
  });

  return {
    textStream: result.textStream,
    initialState: {
      chart_data: mergedChartData,
      results: mergedResults,
      investigation: {
        approach: args.plan.approach,
        steps: perStepMetadata.map((m) => ({
          index: m.index,
          question: m.question,
          rationale: m.rationale,
          failed: m.failed,
          degraded: m.degraded,
        })),
      },
    },
  };
}
