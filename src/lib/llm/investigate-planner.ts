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
 * - Sub-questions declare their dependencies as `depends_on: number[]` —
 *   the indices of prior sub-questions whose results they need. Empty
 *   array = independent (runs in wave 0). Multiple entries = wait for all
 *   listed priors. The orchestrator schedules sub-questions in waves so
 *   independents run in parallel and dependents follow.
 *
 * - Back-compat: the parser accepts the legacy `number | null` shape and
 *   coerces it to `[]` or `[n]` so plans saved from older versions still
 *   load.
 *
 * - The planner sees only the SCHEMA, never row values. Same privacy
 *   model as the existing code-gen path.
 *
 * - Output is JSON. The model is instructed to emit clean JSON; we parse
 *   defensively and surface a clear error if it doesn't.
 */

import { generateText } from "ai";
import { getModel, cachedSystem } from "@/lib/llm/client";
import { PLANNER_MODEL, LLM_MAX_OUTPUT_TOKENS } from "@/lib/constants";
import type { CSVSchema, WarehouseTableSchema, FilterValue } from "@/lib/types";
import { logger } from "@/lib/logger";

/** Hard cap on how many prior sub-questions a single dependent can reference. */
export const MAX_DEPENDS_PER_SUBQUESTION = 3;

export interface PlannedSubQuestion {
  /** A focused, single-pipeline-run question. */
  question: string;
  /** Why this sub-question is part of the investigation. Visible to the user. */
  rationale: string;
  /**
   * Indices of prior sub-questions this one depends on (0-based, all must
   * be `< self_index`). Empty array means independent — the sub-question
   * runs in wave 0. Capped at MAX_DEPENDS_PER_SUBQUESTION entries; longer
   * arrays are truncated by the parser with a logged warning.
   */
  depends_on: number[];
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

Declare dependencies as \`depends_on\`: an array of prior sub-question indices (0-based) whose results this one needs. Use \`[]\` (empty array) for sub-questions that can run independently — those execute in parallel. Use \`[N]\` when the sub-question needs ONE prior result (e.g. "Now drill into the top region from step 1"). Use \`[N, M]\` when it genuinely needs BOTH (e.g. "Compare the top region from step 1 with the bottom region from step 2"). Cap dependencies at 3 priors per sub-question. All indices in \`depends_on\` MUST be less than the sub-question's own index.

Pick decomposition styles that fit the question:
- Investigate-an-anomaly: trend → segments → time-of-onset → correlated factors → recommendation
- Compare-two-things: each side's metrics (independent) → side-by-side comparison (depends_on both) → drivers of difference
- Profile-a-segment: descriptives → distribution → outliers → context vs. rest of population
- Trend-analysis: overall trend → by-segment trend → seasonality → outliers → year-over-year

Output STRICT JSON matching this schema:
{
  "approach": "1-2 sentence approach summary",
  "subQuestions": [
    {
      "question": "single focused question",
      "rationale": "why this sub-question advances the investigation",
      "depends_on": []
    }
  ]
}

Example with a multi-dependency step:
{
  "approach": "Compare top and bottom performing regions side by side.",
  "subQuestions": [
    { "question": "Which region had the highest revenue in 2024?", "rationale": "find the top performer", "depends_on": [] },
    { "question": "Which region had the lowest revenue in 2024?", "rationale": "find the bottom performer", "depends_on": [] },
    { "question": "Compare the growth trajectory and seasonality of those two regions.", "rationale": "side-by-side analysis", "depends_on": [0, 1] }
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

/**
 * Prior-investigation context for a scoped follow-up (drill-as-sub-
 * investigation). When the user drills into a chart segment or asks a
 * follow-up on an Investigate result, the planner receives what the parent
 * investigation already established so it can go DEEPER instead of repeating
 * it, optionally restricted to a drilled segment.
 */
export interface InvestigateScope {
  /** The question the parent investigation answered. */
  parent_question?: string;
  /** The parent investigation's approach (from its plan). */
  prior_approach?: string;
  /** Sub-questions the parent already explored (so we don't repeat them). */
  prior_steps?: string[];
  /** Segment filters to restrict every sub-question to (from a chart drill). */
  filters?: { column: string; value: FilterValue }[];
  /** Human-readable label for the drilled segment. */
  segment_label?: string;
}

function buildScopeBlock(scope: InvestigateScope): string {
  const lines: string[] = ["## Prior Investigation Context — this is a scoped follow-up"];
  lines.push(
    `The user previously investigated: "${scope.parent_question ?? "(a prior analysis)"}"`
  );
  if (scope.prior_approach) lines.push(`Prior approach: ${scope.prior_approach}`);
  if (scope.prior_steps?.length) {
    lines.push(`Already explored (do NOT repeat these):`);
    for (const s of scope.prior_steps.slice(0, 8)) lines.push(`- ${s}`);
  }
  if (scope.filters?.length) {
    const f = scope.filters
      .map((x) =>
        Array.isArray(x.value)
          ? `${x.column} in (${x.value.join(", ")})`
          : `${x.column} = ${x.value}`
      )
      .join(" AND ");
    lines.push(
      `SCOPE every sub-question to this segment${scope.segment_label ? ` (${scope.segment_label})` : ""}: ${f}. Filter to it in the generated code.`
    );
  }
  lines.push(
    `\nTreat the prior findings as established — do not re-derive them. Decompose the follow-up into 2-4 sub-questions that go DEEPER${scope.filters?.length ? " within this segment" : ""}, building on what was already explored rather than restating it.`
  );
  return lines.join("\n") + "\n\n";
}

function buildPlannerUserPrompt(
  question: string,
  schema: CSVSchema | null,
  warehouse?: WarehouseTableSchema[],
  scope?: InvestigateScope
): string {
  const scopeBlock = scope ? buildScopeBlock(scope) : "";
  return `${scopeBlock}## User Question
${question}

## Schema
${summarizeSchemaForPlanner(schema, warehouse)}

Decompose the question into ${scope ? "2-4" : "3-5"} sub-questions following the rules above. Output JSON only.`;
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

/**
 * Coerce a raw `depends_on` value (which may be the new `number[]` form,
 * the legacy `number | null` form, or junk) into a validated `number[]`.
 *
 * Rules applied (each silently drops invalid entries; never throws):
 * - `null` / `undefined` → `[]`
 * - A scalar number `n` → `[n]` (legacy back-compat)
 * - A scalar string / boolean / other → `[]` (the legacy parser used to
 *   set this to null on a string "1"; we keep the same conservative
 *   behavior so a model that emits `"1"` doesn't silently get a dep)
 * - An array → keep entries that are integer numbers, ≥ 0, and strictly
 *   less than `selfIndex`. De-duplicate. Cap at MAX_DEPENDS_PER_SUBQUESTION.
 */
function normalizeDependsOn(raw: unknown, selfIndex: number): number[] {
  if (raw === null || raw === undefined) return [];

  // Legacy scalar form: number (>= 0, < self)
  if (typeof raw === "number") {
    if (Number.isInteger(raw) && raw >= 0 && raw < selfIndex) {
      return [raw];
    }
    return [];
  }

  if (!Array.isArray(raw)) return [];

  const seen = new Set<number>();
  const out: number[] = [];
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isInteger(v)) continue;
    if (v < 0 || v >= selfIndex) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_DEPENDS_PER_SUBQUESTION) break;
  }
  return out;
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
    const depends_on = normalizeDependsOn(sq.depends_on, i);
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
  model: string = PLANNER_MODEL,
  scope?: InvestigateScope
): Promise<ParsedPlanResult | ParseError> {
  logger.info("Investigate: generating plan", {
    question: question.slice(0, 200),
    hasSchema: !!schema,
    warehouseTables: warehouse?.length ?? 0,
    scoped: !!scope,
    scopeFilters: scope?.filters?.length ?? 0,
  });

  const result = await generateText({
    model: getModel(model),
    system: cachedSystem(PLANNER_SYSTEM_PROMPT),
    prompt: buildPlannerUserPrompt(question, schema, warehouse, scope),
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

// ── Re-planner ─────────────────────────────────────────────────
//
// After each wave of sub-questions completes, the orchestrator asks the
// re-planner what to do next based on what was learned. This is the
// closed-loop bit that turns Investigate from a batch executor into an
// agent: the plan can grow, shrink, or terminate early based on
// intermediate findings.
//
// Privacy posture: same as the planner — the re-planner sees only
// SCHEMA + RESULT SUMMARIES (key types, chart shapes). Never row
// values.

export type ReplanAction = "continue" | "amend" | "stop";

export interface ReplanDecision {
  action: ReplanAction;
  /** 1-2 sentence explanation of why; shown to the user as a step in the live UI. */
  rationale: string;
  /** When action === "amend": new sub-questions to append. depends_on indices reference the FULL post-amend plan. */
  addSubQuestions: PlannedSubQuestion[];
  /** When action === "amend": indices of PENDING sub-questions to drop (already-executed ones cannot be removed). */
  removeSubQuestionIndices: number[];
}

/** Per-sub-question summary passed to the re-planner — schema-only. */
export interface SubQuestionResultSummary {
  index: number;
  question: string;
  rationale: string;
  status: "success" | "degraded" | "failed";
  /** Compact description of result keys with their JS types. */
  resultKeys?: Record<string, string>;
  /** For each chart_data key: column names and row count. */
  chartDataShapes?: Record<string, { columns: string[]; rows: number }>;
  /** Set when status === "degraded": the validator's reason. */
  degradedReason?: string;
  /** Set when status === "failed": short error preview. */
  errorPreview?: string;
}

const REPLANNER_SYSTEM_PROMPT = `You are a data analysis re-planner. You're mid-investigation. A wave of sub-questions has just completed and you must decide whether the original plan still makes sense.

You will see:
- The original user question.
- The original plan (approach + all sub-questions with depends_on).
- Result summaries for every sub-question completed so far (status: success / degraded / failed, plus result-key types and chart shapes — NO row values).
- The remaining pending sub-questions.
- The current hop count and remaining budget.

Choose ONE action:

1. "continue" — the plan is on track. No changes. Use this most of the time.

2. "amend" — the findings suggest a follow-up that wasn't in the original plan, OR a pending sub-question is no longer informative because of what's been learned. You may:
   - addSubQuestions: append 1-3 new sub-questions. Each new sub-question's depends_on indices may reference any sub-question that will exist after the amendment (already-completed or newly added). Cap depends_on at 3 entries per sub-question.
   - removeSubQuestionIndices: drop 1+ PENDING sub-questions (indices listed in the "Pending sub-questions" section). You cannot remove already-completed ones.

3. "stop" — nothing in the completed results suggests pursuing the remaining sub-questions. The composer should synthesize with what we have. Use this when the findings are clear-cut and remaining pending sub-questions would be busywork.

Rules:
- Do NOT duplicate the rationale of any existing sub-question. If a finding is already established, don't ask it again.
- Each new sub-question must be answerable by ONE Python script and reference real columns from the schema.
- depends_on indices in new sub-questions are in the FULL POST-AMEND plan numbering (existing sub-questions keep their original indices; new ones append).
- Prefer "continue" when in doubt. Re-plans cost time and tokens.
- If remaining budget is 0 (you've already hit the hop cap), only "continue" or "stop" are valid — "amend" will be ignored.

Output STRICT JSON:
{
  "action": "continue" | "amend" | "stop",
  "rationale": "1-2 sentence explanation",
  "addSubQuestions": [],
  "removeSubQuestionIndices": []
}

Output ONLY the JSON object. No markdown fencing, no preamble.`;

function summarizeResultsForReplanner(completed: SubQuestionResultSummary[]): string {
  if (completed.length === 0) return "(no sub-questions completed yet)";
  const lines: string[] = [];
  for (const r of completed) {
    lines.push(`### Step ${r.index} — ${r.status.toUpperCase()}`);
    lines.push(`Question: ${r.question}`);
    if (r.rationale) lines.push(`Rationale: ${r.rationale}`);
    if (r.status === "failed" && r.errorPreview) {
      lines.push(`Error: ${r.errorPreview}`);
    } else if (r.status === "degraded" && r.degradedReason) {
      lines.push(`Degraded: ${r.degradedReason}`);
    }
    if (r.resultKeys && Object.keys(r.resultKeys).length > 0) {
      const keys = Object.entries(r.resultKeys)
        .slice(0, 10)
        .map(([k, t]) => `${k}: ${t}`)
        .join(", ");
      lines.push(`Result keys: ${keys}`);
    }
    if (r.chartDataShapes && Object.keys(r.chartDataShapes).length > 0) {
      const shapes = Object.entries(r.chartDataShapes)
        .slice(0, 5)
        .map(([k, s]) => `${k}: ${s.rows}rows × [${s.columns.slice(0, 6).join(", ")}]`)
        .join("; ");
      lines.push(`Chart data: ${shapes}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildReplannerUserPrompt(args: {
  originalQuestion: string;
  approach: string;
  allSubQuestions: PlannedSubQuestion[];
  completed: SubQuestionResultSummary[];
  pendingIndices: number[];
  schema: CSVSchema | null;
  warehouse?: WarehouseTableSchema[];
  hopCount: number;
  remainingHops: number;
  subQuestionsBudget: number;
}): string {
  const planLines = args.allSubQuestions
    .map((sq, i) => `  ${i}. "${sq.question}" — depends_on: [${sq.depends_on.join(", ")}]`)
    .join("\n");

  const pendingLines =
    args.pendingIndices.length === 0
      ? "(none — all waves complete; this is the terminal re-plan call before composition)"
      : args.pendingIndices.map((i) => `  ${i}. ${args.allSubQuestions[i].question}`).join("\n");

  return `## Original User Question
${args.originalQuestion}

## Original Approach
${args.approach}

## Original Plan
${planLines}

## Sub-questions Completed So Far
${summarizeResultsForReplanner(args.completed)}

## Pending Sub-questions
${pendingLines}

## Schema
${summarizeSchemaForPlanner(args.schema, args.warehouse)}

## Budget
- Re-plan hops used: ${args.hopCount} of ${args.hopCount + args.remainingHops} max
- Sub-question budget remaining: ${args.subQuestionsBudget} (current plan: ${args.allSubQuestions.length})

Decide. Output JSON only.`;
}

function parseReplannerOutput(
  raw: string,
  currentPlanLength: number
): { ok: true; decision: ReplanDecision } | { ok: false; error: string } {
  const stripped = extractJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (err) {
    return {
      ok: false,
      error: `Re-planner output was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, error: "Re-planner output was not an object" };
  }
  const obj = parsed as Record<string, unknown>;

  const actionRaw = typeof obj.action === "string" ? obj.action : "";
  let action: ReplanAction;
  if (actionRaw === "continue" || actionRaw === "amend" || actionRaw === "stop") {
    action = actionRaw;
  } else {
    return { ok: false, error: `Invalid action: ${actionRaw}` };
  }

  const rationale = typeof obj.rationale === "string" ? obj.rationale.trim() : "";

  const addSubQuestions: PlannedSubQuestion[] = [];
  const addRaw = obj.addSubQuestions;
  if (Array.isArray(addRaw)) {
    // New sub-questions' indices in depends_on reference the POST-AMEND plan,
    // i.e. their own slot is `currentPlanLength + position`. Cap at 3 added.
    for (let pos = 0; pos < addRaw.length && pos < 3; pos++) {
      const sq = addRaw[pos] as Record<string, unknown>;
      if (!sq || typeof sq !== "object") continue;
      const question = typeof sq.question === "string" ? sq.question.trim() : "";
      if (question.length < 5) continue;
      const rationaleS = typeof sq.rationale === "string" ? sq.rationale.trim() : "";
      const selfIdx = currentPlanLength + pos;
      const depends_on = normalizeDependsOn(sq.depends_on, selfIdx);
      addSubQuestions.push({ question, rationale: rationaleS, depends_on });
    }
  }

  const removeSubQuestionIndices: number[] = [];
  const removeRaw = obj.removeSubQuestionIndices;
  if (Array.isArray(removeRaw)) {
    const seen = new Set<number>();
    for (const v of removeRaw) {
      if (typeof v !== "number" || !Number.isInteger(v)) continue;
      if (v < 0 || v >= currentPlanLength) continue;
      if (seen.has(v)) continue;
      seen.add(v);
      removeSubQuestionIndices.push(v);
    }
  }

  return { ok: true, decision: { action, rationale, addSubQuestions, removeSubQuestionIndices } };
}

/**
 * Ask the re-planner what to do given the current state of the investigation.
 * Falls back to `continue` on any LLM or parse failure — the loop must always
 * be able to make forward progress.
 */
export async function generateReplan(args: {
  originalQuestion: string;
  approach: string;
  allSubQuestions: PlannedSubQuestion[];
  completed: SubQuestionResultSummary[];
  pendingIndices: number[];
  schema: CSVSchema | null;
  warehouse?: WarehouseTableSchema[];
  hopCount: number;
  remainingHops: number;
  subQuestionsBudget: number;
  model?: string;
}): Promise<ReplanDecision> {
  const fallback: ReplanDecision = {
    action: "continue",
    rationale: "Re-planner unavailable; continuing with current plan.",
    addSubQuestions: [],
    removeSubQuestionIndices: [],
  };

  if (args.remainingHops <= 0) {
    // Budget exhausted; the only valid choices are continue or stop, and
    // we can't ask the LLM here because amend would be ignored. Default
    // to continue (cheapest, least surprising).
    return { ...fallback, rationale: "Re-plan budget exhausted; continuing." };
  }

  logger.info("Investigate: re-planning", {
    hopCount: args.hopCount,
    completed: args.completed.length,
    pending: args.pendingIndices.length,
  });

  try {
    const result = await generateText({
      model: getModel(args.model ?? PLANNER_MODEL),
      system: cachedSystem(REPLANNER_SYSTEM_PROMPT),
      prompt: buildReplannerUserPrompt(args),
      temperature: 0.3,
      maxOutputTokens: LLM_MAX_OUTPUT_TOKENS,
    });
    const parsed = parseReplannerOutput(result.text, args.allSubQuestions.length);
    if (!parsed.ok) {
      logger.warn("Investigate: re-planner parse failed; falling back to continue", {
        error: parsed.error,
      });
      return fallback;
    }
    logger.info("Investigate: re-plan decision", {
      action: parsed.decision.action,
      add: parsed.decision.addSubQuestions.length,
      remove: parsed.decision.removeSubQuestionIndices.length,
    });
    return parsed.decision;
  } catch (err) {
    logger.warn("Investigate: re-planner LLM call failed; falling back to continue", {
      error: err instanceof Error ? err.message : String(err),
    });
    return fallback;
  }
}

// ── Test seam ─────────────────────────────────────────────────

export const __testing = {
  extractJsonObject,
  summarizeSchemaForPlanner,
  normalizeDependsOn,
  parseReplannerOutput,
  buildPlannerUserPrompt,
};
