/**
 * Lookup-vs-deep classifier for drill-as-sub-investigation cost control.
 *
 * A follow-up or chart drill on an Investigate result is auto-routed back to
 * Investigate (sticky depth). Without a gate, that means every follow-up — and
 * every rapid chart drill — fires a full multi-step investigation, and LLM
 * cost runs amok. This classifier decides whether a follow-up genuinely needs
 * the deep loop or can be answered by a single-shot pass.
 *
 * Design: cheap (one Haiku call, single-token output), and **asymmetric** — it
 * defaults to `lookup` and any error/timeout/ambiguity resolves to `lookup`.
 * A wrong-lookup is recoverable (the user re-asks or escalates); a wrong-deep
 * is the runaway cost. So failure can never cause a cost spike.
 */

import { generateText } from "ai";
import { getModel } from "@/lib/llm/client";
import { FOLLOWUP_CLASSIFIER_MODEL } from "@/lib/constants";
import { logger, errMessage } from "@/lib/logger";
import type { InvestigateScope } from "@/lib/llm/investigate-planner";

export type FollowupDepth = "lookup" | "deep";

const SYSTEM_PROMPT = `You route follow-up questions in a data-analysis tool. Decide whether a follow-up on a prior analysis needs a DEEP multi-step investigation, or just a quick single-step LOOKUP.

Answer with EXACTLY one letter: L or D.

Default to L. Only answer D when the follow-up clearly needs MULTIPLE analytical angles, a root-cause / "why" explanation, or a multi-step breakdown.

L (lookup) examples: "what is the exact number for March", "how many in the West region", "show me that as a table", "list the top 5", "filter to enterprise customers", a single segment view, a single-chart request.
D (deep) examples: "why did it spike", "what's driving the difference", "investigate the drop", "break this down and explain the factors", "compare and explain why they diverge".`;

/**
 * Map raw model output to a verdict. Pure; biased to lookup — anything that
 * isn't an unambiguous "deep" signal resolves to lookup.
 */
export function parseDepthVerdict(text: string): FollowupDepth {
  const t = text.trim().toLowerCase();
  if (!t) return "lookup";
  // First meaningful character / word wins.
  if (t.startsWith("d") || t.includes("deep")) return "deep";
  return "lookup";
}

function buildUserPrompt(question: string, scope?: InvestigateScope): string {
  const parent = scope?.parent_question ? `"${scope.parent_question}"` : "(a prior analysis)";
  const approach = scope?.prior_approach ? ` (approach: ${scope.prior_approach})` : "";
  const seg = scope?.filters?.length
    ? `\nScoped to segment: ${scope.filters.map((f) => `${f.column} = ${f.value}`).join(" AND ")}`
    : "";
  return `Prior analysis: ${parent}${approach}${seg}
Follow-up: "${question}"
Answer (L or D):`;
}

/**
 * Classify a follow-up as `lookup` or `deep`. Lookup-biased and fail-safe:
 * returns `lookup` on any error/timeout so a classifier outage can never cause
 * a cost spike.
 */
export async function classifyFollowupDepth(args: {
  question: string;
  scope?: InvestigateScope;
  model?: string;
}): Promise<FollowupDepth> {
  const { question, scope, model = FOLLOWUP_CLASSIFIER_MODEL } = args;
  try {
    const result = await generateText({
      model: getModel(model),
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(question, scope),
      temperature: 0,
      maxOutputTokens: 4,
    });
    const verdict = parseDepthVerdict(result.text);
    logger.info("Followup classifier", {
      question: question.slice(0, 120),
      verdict,
      raw: result.text.trim().slice(0, 8),
    });
    return verdict;
  } catch (err) {
    // Fail-safe to the cheap path — never let a classifier failure escalate cost.
    logger.warn("Followup classifier failed; defaulting to lookup", {
      error: errMessage(err),
    });
    return "lookup";
  }
}
