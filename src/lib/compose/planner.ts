/**
 * The plan call (specs/narrative-compiler-2026-08-09.md §2) — the ONE LLM
 * invocation in compiled composition: manifest projection in, {plan,
 * insight} JSON out (~hundreds of tokens). Invalid plan → one retry with
 * the validator's errors; then the deterministic default plan. The
 * compiled pipeline cannot fail to produce a dashboard.
 */
import { generateText } from "ai";
import { z } from "zod";
import { getModel, cachedSystem } from "@/lib/llm/client";
import { withPhase } from "@/lib/cost/accumulator";
import { projectManifestForPrompt } from "@/lib/findings/project";
import { logger } from "@/lib/logger";
import type { FindingEntry } from "@/lib/contracts/findings";
import type { Plan } from "@/lib/contracts/plan";
import { PLAN_OPS, defaultPlan, nextPlanNodeId, planBudget, validatePlan } from "./plan";

const PlannerResponse = z.object({
  nodes: z
    .array(
      z.object({
        op: z.enum(PLAN_OPS),
        refs: z.array(z.string()).default([]),
        text: z.string().optional(),
        anchor: z.string().optional(),
      })
    )
    .min(1)
    .max(32),
});

/** Planner system prompt for a style — the node budget and depth directive
 *  are the PURPOSE dimension of compiled composition (plan.ts
 *  PLAN_BUDGETS); everything else is the fixed grammar. */
export function buildPlannerSystem(purpose?: string): string {
  const budget = planBudget(purpose);
  return `You are WRITING a data dashboard's narrative — an analyst telling the story, not a template printing fields. You receive the analysis' declared claims (findings with definitions and value_fields — no raw data). Respond with ONLY a JSON object:
{"nodes":[{"op":"ANSWER|TREND|SHAPE|PEAK|ENDPOINT|CONTRAST|NOTE|CAVEAT|INSIGHT","refs":["<claim name>", ...],"text":"..."}]}
Rules:
- Every node's "text" IS the prose the reader sees: flowing sentences (2-4 for document styles) that interpret and CONNECT its claims — carry the thread from the previous node, vary sentence shape, subordinate the less important figure to the more important one. Never write label-colon-value ("Churn trend: rising at X").
- EVERY figure — number, year, month, count, percentage — MUST be a binding: $finding:<claim>.<field> (fields are listed per claim as value_fields). Literal digits anywhere in text are REJECTED. A node's bindings may only use claims listed in its refs.
- EXACTLY ONE ANSWER node at the TOP (only an opening METHOD may precede it): the direct answer to the user's question in plain words, figures bound. METHOD may instead close the document where the style's guidance says so.
- Document ops: SECTION (short heading, no refs) titles what follows. EXPLAIN narrates a chart — set "anchor" to that chart's id (listed under Charts) and the chart renders right below your words; every anchored chart needs its EXPLAIN. CALLOUT flags what deserves the reader's attention. METHOD explains how the analysis was done, grounded ONLY in the claims' stated definitions. CONCLUSION closes with the answer restated and its strongest figures (bound). NEXT_STEPS suggests follow-up QUESTIONS/ACTIONS (never phrased as findings). LIMITS states plainly what this analysis does not cover.
- CAVEAT nodes carry NO text (the system renders the check's own declared fields verbatim — a caveat is not yours to phrase); include one for every FAILED check, and set its "anchor" to the chart/section it qualifies so it sits WHERE it applies. CAVEATs may reference ONLY checks/screens.
- At most one INSIGHT node: synthesis ACROSS claims that no single node states.
- NEVER assert a mechanism, cause, coverage change, or data-collection story no check reports ("currency coverage collapsed", "reporting still arriving" are fabrications unless a check's definition literally states them). Describe what the data shows; do not explain why it happened.
- refs use claim names exactly as given. ${budget.guidance}`;
}

/** The default-style prompt (kept for compatibility/tests). */
export const PLANNER_SYSTEM = buildPlannerSystem();

export async function generatePlan(args: {
  findings: FindingEntry[];
  question: string;
  model: string;
  /** Output style (purpose id) — scales the plan's node budget. */
  purpose?: string;
  /** Shipped views the plan may anchor EXPLAIN/CAVEAT nodes to. */
  views?: { id: string; title: string }[];
}): Promise<{ plan: Plan; plannerErrors: string[] }> {
  const { projections } = projectManifestForPrompt(args.findings);
  const viewsSection =
    args.views && args.views.length > 0
      ? `\n\n## Charts (anchor EXPLAIN/CAVEAT nodes to these ids)\n${JSON.stringify(args.views)}`
      : "";
  const prompt = `## Question\n${args.question}\n\n## Claims\n${JSON.stringify(projections)}${viewsSection}\n\nWrite the narrative.`;
  const errors: string[] = [];
  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await withPhase("compose", () =>
        generateText({
          model: getModel(args.model),
          system: cachedSystem(buildPlannerSystem(args.purpose)),
          prompt: prompt + feedback,
          temperature: 0,
          maxOutputTokens: 4500,
        })
      );
      const start = res.text.indexOf("{");
      const end = res.text.lastIndexOf("}");
      const parsed = PlannerResponse.safeParse(JSON.parse(res.text.slice(start, end + 1)));
      if (!parsed.success) {
        errors.push(`attempt ${attempt}: ${parsed.error.issues[0]?.message ?? "malformed"}`);
        feedback = `\n\nYour previous plan was malformed: ${errors[errors.length - 1]}. Respond with only the JSON object.`;
        continue;
      }
      const plan: Plan = {
        nodes: parsed.data.nodes.map((n) => ({ id: nextPlanNodeId(), ...n })),
      };
      const v = validatePlan(plan, args.findings);
      if (v.ok) return { plan, plannerErrors: errors };
      errors.push(...v.errors.map((e) => `attempt ${attempt}: ${e}`));
      feedback = `\n\nYour previous plan was INVALID:\n- ${v.errors.join("\n- ")}\nFix these and respond with only the JSON object.`;
    } catch (err) {
      errors.push(`attempt ${attempt}: ${err instanceof Error ? err.message : String(err)}`);
      feedback = "";
    }
  }
  logger.warn("Planner failed validation twice — using the deterministic default plan", {
    errors: errors.slice(0, 4),
  });
  return { plan: defaultPlan(args.findings, args.purpose), plannerErrors: errors };
}
