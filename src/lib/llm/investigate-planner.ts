/**
 * Investigate planner — decomposes a user's complex question into 3-5
 * sub-questions that together answer the original. Returns a structured
 * plan that the orchestrator runs through the existing pipeline.
 *
 * Design notes:
 *
 * - Each sub-question is meant to be answerable by ONE pipeline run
 *   (one Python script, one set of charts). The planner's job is to find
 *   the right grain of decomposition: not too coarse (becomes a single
 *   shot) and not too fine (combinatorial blow-up of LLM calls).
 *
 * - Sub-questions can be marked dependent on a prior step. The orchestrator
 *   runs independent sub-questions in parallel for speed; dependents run
 *   after their predecessor completes. v1 supports a single linear
 *   dependency chain (depends_on is one prior index) — no DAGs.
 *
 * - The planner sees only the SCHEMA, never row values. Same privacy
 *   model as the existing code-gen path.
 *
 * - Output is JSON. The model is instructed to emit clean JSON; we parse
 *   defensively and surface a clear error if it doesn't.
 */

import { generateText } from "ai";
import { getModel } from "@/lib/llm/client";
import { CODE_GEN_MODEL, LLM_MAX_OUTPUT_TOKENS } from "@/lib/constants";
import type { CSVSchema, WarehouseTableSchema } from "@/lib/types";
import { logger } from "@/lib/logger";

export interface PlannedSubQuestion {
  /** A focused, single-pipeline-run question. */
  question: string;
  /** Why this sub-question is part of the investigation. Visible to the user. */
  rationale: string;
  /**
   * Index of a prior sub-question this one depends on (0-based), or null
   * if independent. v1 supports single-predecessor chains only.
   */
  depends_on: number | null;
}

export interface InvestigationPlan {
  /** A 1-2 sentence framing of how the planner is approaching the question. */
  approach: string;
  /** 3-7 sub-questions in execution order. */
  subQuestions: PlannedSubQuestion[];
}

const PLANNER_SYSTEM_PROMPT = `You are a data analysis planner. Given a user's question and a dataset schema, decompose the question into 3-5 focused sub-questions that together answer the original.

Each sub-question should:
- Be answerable by ONE Python data-analysis script (groupBy, aggregation, simple chart, statistical test, etc.)
- Reference real columns from the schema
- Have a clear analytical purpose distinct from the others
- Not duplicate work across sub-questions

Mark a sub-question as depends_on: <prior-index> only when its analysis genuinely requires the result of the prior one (e.g. "Now drill into the top region from step 1"). Otherwise mark depends_on: null so they can run in parallel.

Pick decomposition styles that fit the question:
- Investigate-an-anomaly: trend → segments → time-of-onset → correlated factors → recommendation
- Compare-two-things: each side's metrics → side-by-side comparison → drivers of difference
- Profile-a-segment: descriptives → distribution → outliers → context vs. rest of population
- Trend-analysis: overall trend → by-segment trend → seasonality → outliers → year-over-year

Output STRICT JSON matching this schema:
{
  "approach": "1-2 sentence approach summary",
  "subQuestions": [
    {
      "question": "single focused question",
      "rationale": "why this sub-question advances the investigation",
      "depends_on": null
    }
  ]
}

Output ONLY the JSON object. No markdown fencing, no preamble. The minimum number of sub-questions is 3, the maximum is 7.`;

function summarizeSchemaForPlanner(
  schema: CSVSchema | null,
  warehouse?: WarehouseTableSchema[]
): string {
  if (schema) {
    const lines: string[] = [];
    lines.push(`Dataset: ${schema.filename} (${schema.row_count.toLocaleString()} rows)`);
    if (schema.detected_domain) {
      lines.push(`Detected domain: ${schema.detected_domain}`);
    }
    lines.push("Columns:");
    for (const col of schema.columns.slice(0, 50)) {
      const m = col.meta;
      let detail = "";
      if (m.kind === "categorical") {
        const top = m.top_values
          ?.slice(0, 5)
          .map((v) => v.value)
          .join(", ");
        detail = ` — ${m.distinct_count} distinct${top ? `; top: ${top}` : ""}`;
      } else if (m.kind === "number") {
        detail = ` — range [${m.min}, ${m.max}]; mean ${m.mean.toFixed(2)}`;
      } else if (m.kind === "date") {
        detail = ` — ${m.granularity}, [${m.min_date} → ${m.max_date}]`;
      }
      lines.push(`  - ${col.name} (${col.dtype})${detail}`);
    }
    if (schema.correlations?.length) {
      const top = schema.correlations.slice(0, 3);
      lines.push(
        `Notable correlations: ${top.map((c) => `${c.col_a}↔${c.col_b}=${c.pearson.toFixed(2)}`).join(", ")}`
      );
    }
    return lines.join("\n");
  }

  if (warehouse && warehouse.length > 0) {
    return [
      `Warehouse with ${warehouse.length} tables:`,
      ...warehouse.slice(0, 12).map((t) => {
        const cols = t.columns
          .slice(0, 12)
          .map((c) => `${c.name} (${c.type})`)
          .join(", ");
        return `  ${t.schema}.${t.name} (~${t.row_count_estimate.toLocaleString()} rows): ${cols}`;
      }),
    ].join("\n");
  }

  return "(no schema available)";
}

function buildPlannerUserPrompt(
  question: string,
  schema: CSVSchema | null,
  warehouse?: WarehouseTableSchema[]
): string {
  return `## User Question
${question}

## Schema
${summarizeSchemaForPlanner(schema, warehouse)}

Decompose the question into 3-5 sub-questions following the rules above. Output JSON only.`;
}

/**
 * Strip common JSON-output noise: markdown fences, backticks, leading text.
 * The system prompt says "JSON only" but models sometimes preface with
 * "Here is the plan:" or wrap in ```json fences.
 */
function extractJsonObject(raw: string): string {
  let s = raw.trim();
  // Strip markdown fences
  const fence = s.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  // Find the first { and last } — the planner emits one object
  const firstBrace = s.indexOf("{");
  const lastBrace = s.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    s = s.slice(firstBrace, lastBrace + 1);
  }
  return s;
}

export interface ParsedPlanResult {
  ok: true;
  plan: InvestigationPlan;
}

export interface ParseError {
  ok: false;
  error: string;
  rawOutput: string;
}

/**
 * Parse and validate the planner's JSON output. Returns a tagged result so
 * callers can decide whether to fall back to a single-shot Ask on failure.
 */
export function parsePlannerOutput(raw: string): ParsedPlanResult | ParseError {
  const stripped = extractJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    return {
      ok: false,
      error: `Planner output was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      rawOutput: raw,
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "Planner output was not an object", rawOutput: raw };
  }
  const obj = parsed as Record<string, unknown>;

  const approach = typeof obj.approach === "string" ? obj.approach : "";
  const subQs = obj.subQuestions;
  if (!Array.isArray(subQs)) {
    return { ok: false, error: "Planner output missing subQuestions array", rawOutput: raw };
  }

  const subQuestions: PlannedSubQuestion[] = [];
  for (let i = 0; i < subQs.length; i++) {
    const sq = subQs[i] as Record<string, unknown>;
    if (!sq || typeof sq !== "object") continue;
    const question = typeof sq.question === "string" ? sq.question.trim() : "";
    if (question.length < 5) continue;
    const rationale = typeof sq.rationale === "string" ? sq.rationale.trim() : "";
    let depends_on: number | null = null;
    if (typeof sq.depends_on === "number" && sq.depends_on >= 0 && sq.depends_on < i) {
      depends_on = sq.depends_on;
    }
    subQuestions.push({ question, rationale, depends_on });
  }

  if (subQuestions.length < 2) {
    return {
      ok: false,
      error: `Planner produced only ${subQuestions.length} usable sub-questions (need ≥2)`,
      rawOutput: raw,
    };
  }
  if (subQuestions.length > 7) {
    // Hard cap to keep cost predictable
    subQuestions.length = 7;
  }

  return { ok: true, plan: { approach, subQuestions } };
}

/**
 * Generate an investigation plan from the user's question + schema.
 * Throws on LLM failure. On parse failure returns a tagged error so the
 * caller can fall back to single-shot Ask.
 */
export async function generatePlan(
  question: string,
  schema: CSVSchema | null,
  warehouse: WarehouseTableSchema[] | undefined,
  model: string = CODE_GEN_MODEL
): Promise<ParsedPlanResult | ParseError> {
  logger.info("Investigate: generating plan", {
    question: question.slice(0, 200),
    hasSchema: !!schema,
    warehouseTables: warehouse?.length ?? 0,
  });

  const result = await generateText({
    model: getModel(model),
    system: PLANNER_SYSTEM_PROMPT,
    prompt: buildPlannerUserPrompt(question, schema, warehouse),
    temperature: 0.3,
    maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
  });

  const parsed = parsePlannerOutput(result.text);
  if (parsed.ok) {
    logger.info("Investigate: plan generated", {
      subQuestionCount: parsed.plan.subQuestions.length,
      approach: parsed.plan.approach.slice(0, 100),
    });
  } else {
    logger.warn("Investigate: plan parse failed", { error: parsed.error });
  }
  return parsed;
}

// ── Test seam ─────────────────────────────────────────────────

export const __testing = { extractJsonObject, summarizeSchemaForPlanner };
