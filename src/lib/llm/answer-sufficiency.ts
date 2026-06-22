/**
 * Conservative "did the materialized CSV actually answer this sub-question?"
 * judge. A warehouse Investigate pulls ONE broad, filtered, capped snapshot up
 * front; most sub-questions can be answered by analyzing it in Python. This
 * cheap check decides whether that snapshot sufficed — or whether the question
 * genuinely needs data outside it, warranting a targeted per-step warehouse
 * query. Calibrated to under-claim: it says "sufficient" only when the snapshot
 * plainly contains what's needed, so we don't present a half-answer.
 */
import { generateText } from "ai";
import { withPhase } from "@/lib/cost/accumulator";
import { getModel, cachedSystem } from "@/lib/llm/client";
import { PLANNER_MODEL } from "@/lib/constants";
import { logger } from "@/lib/logger";

export interface SufficiencyVerdict {
  sufficient: boolean;
  reason: string;
}

const SYSTEM_PROMPT = `You judge whether an analytical sub-question has been ADEQUATELY answered by analysis of an already-materialized dataset, or whether it needs data that dataset does not contain.

The materialized dataset is ONE filtered, capped snapshot pulled up front. It may exclude rows (e.g. only failures, a single quarter, capped at 50000 rows) and columns the question needs.

Set "sufficient": true ONLY when the computed result clearly and fully answers the sub-question using data plainly present in the snapshot. Be conservative — when in doubt, say false. Specifically set false if answering plausibly needs:
- a wider or different time range than the snapshot covers,
- rows the snapshot's filter excluded (e.g. successes when it holds only failures; other statuses, entities, or categories),
- a column not present in the snapshot,
- full/unbiased totals or rankings when the snapshot is a capped sample (a 50000-row cap can bias counts).

If the result is empty, degenerate, or doesn't address the question, set false.

Output ONLY JSON: {"sufficient": boolean, "reason": "<one short sentence>"}. No prose, no markdown.`;

export async function assessAnswerSufficiency(args: {
  /** The sub-question being answered. */
  question: string;
  /** What the materialized snapshot contains: its pull query, columns, row cap. */
  datasetDescription: string;
  /** What the Python analysis actually computed from it. */
  resultSummary: string;
  model?: string;
}): Promise<SufficiencyVerdict> {
  try {
    const result = await withPhase("assess", () =>
      generateText({
        model: getModel(args.model ?? PLANNER_MODEL),
        system: cachedSystem(SYSTEM_PROMPT),
        prompt: `## Sub-question
${args.question}

## Materialized snapshot (the only data analyzed)
${args.datasetDescription}

## Result computed from it
${args.resultSummary}

Was the sub-question adequately answered by this? JSON only.`,
        temperature: 0,
        maxOutputTokens: 300,
      })
    );
    const match = result.text.match(/\{[\s\S]*\}/);
    if (!match) return { sufficient: false, reason: "unparseable assessment" };
    const parsed = JSON.parse(match[0]) as { sufficient?: unknown; reason?: unknown };
    return {
      sufficient: parsed.sufficient === true,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
    };
  } catch (err) {
    // If the judge itself is unavailable, keep the already-computed CSV result
    // rather than escalating into the warehouse (which is the costly/error-prone
    // path this whole flow exists to avoid). Robustness over the strict ideal.
    logger.warn("Answer-sufficiency assessment failed; keeping CSV result", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { sufficient: true, reason: "assessment unavailable" };
  }
}
