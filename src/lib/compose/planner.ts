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
import { PLAN_OPS, defaultPlan, nextPlanNodeId, validatePlan } from "./plan";

const PlannerResponse = z.object({
  nodes: z
    .array(
      z.object({
        op: z.enum(PLAN_OPS),
        refs: z.array(z.string()).default([]),
        text: z.string().optional(),
      })
    )
    .min(1)
    .max(16),
});

export const PLANNER_SYSTEM = `You are planning a data dashboard's narrative. You receive the analysis' declared claims (findings with definitions — no raw data). Respond with ONLY a JSON object:
{"nodes":[{"op":"ANSWER|TREND|SHAPE|PEAK|ENDPOINT|CONTRAST|NOTE|CAVEAT|INSIGHT","refs":["<claim name>", ...],"text":"..."}]}
Rules:
- EXACTLY ONE ANSWER node: the claim(s) that answer the user's question most directly.
- CAVEAT nodes may reference ONLY checks/screens (dtype "check"/"screen"); include one for every FAILED check.
- At most one INSIGHT node: 1-3 sentences of synthesis ACROSS claims ("text"), the only free prose you may write — every number in it must be a $finding:<name>.<field> binding, never a literal.
- refs use claim names exactly as given. Order nodes by importance. 4-9 nodes total.
- Do not restate what a single claim already says in INSIGHT — that is what the other nodes render.
- INSIGHT may ONLY connect facts the claims state. NEVER assert a mechanism, coverage change, or data-collection story no check reports ("currency coverage collapsed", "reporting still arriving" are fabrications unless a check's definition literally states them). If you cannot ground a synthesis in the listed claims, omit the INSIGHT node entirely — absent insight beats invented insight.`;

export async function generatePlan(args: {
  findings: FindingEntry[];
  question: string;
  model: string;
}): Promise<{ plan: Plan; plannerErrors: string[] }> {
  const { projections } = projectManifestForPrompt(args.findings);
  const prompt = `## Question\n${args.question}\n\n## Claims\n${JSON.stringify(projections)}\n\nPlan the narrative.`;
  const errors: string[] = [];
  let feedback = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await withPhase("compose", () =>
        generateText({
          model: getModel(args.model),
          system: cachedSystem(PLANNER_SYSTEM),
          prompt: prompt + feedback,
          temperature: 0,
          maxOutputTokens: 1200,
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
  return { plan: defaultPlan(args.findings), plannerErrors: errors };
}
