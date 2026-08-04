import type { Spec } from "@/lib/contracts/spec";
import type { FilterValue } from "@/lib/contracts/spec-types";
import type { InvestigateScope } from "@/lib/contracts/investigation";
import { readStreamState } from "@/lib/contracts/stream-state";

/**
 * Specs produced by Investigate carry `__plan` in their state. Used to gate
 * Investigate-only rendering conventions (step-citation superscripts) so
 * Ask-mode prose is rendered verbatim.
 */
export function specHasInvestigation(spec: Spec | null | undefined): boolean {
  return readStreamState(spec).__plan !== undefined;
}

/**
 * Build the scoped-follow-up context for an Investigate, from the prior
 * investigation's `__plan` (approach + the sub-questions it already explored)
 * plus any drilled-segment filters. Drives drill-as-sub-investigation: the new
 * plan goes deeper instead of repeating the parent. Returns undefined when
 * there's nothing to scope (no prior plan and no filters).
 */
export function buildInvestigateScope(
  spec: Spec | null | undefined,
  extra?: {
    parentQuestion?: string;
    filters?: { column: string; value: FilterValue }[];
    segmentLabel?: string;
  }
): InvestigateScope | undefined {
  const plan = readStreamState(spec).__plan;
  const hasPlan = !!plan && typeof plan === "object";
  if (!hasPlan && !extra?.filters?.length) return undefined;
  return {
    parent_question: extra?.parentQuestion,
    prior_approach: hasPlan ? plan!.approach : undefined,
    prior_steps:
      hasPlan && Array.isArray(plan!.steps)
        ? plan!.steps.map((s) => s.question).filter((q): q is string => !!q)
        : undefined,
    filters: extra?.filters,
    segment_label: extra?.segmentLabel,
  };
}

/** One level of the drill-down breadcrumb stack. */
export interface DrillLevel {
  question: string;
  segmentLabel: string;
  spec: Spec;
}
