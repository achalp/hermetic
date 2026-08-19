/**
 * Pure step-merge helpers lifted OUT of the runInvestigateQuery god-function so
 * they can be unit-tested (that 1.3k-LOC orchestrator was integration-only).
 *
 * Investigate runs N sub-questions and merges their outputs under the
 * composer's `step_N_` prefix (0-based step index → 1-based prefix). Both of
 * these were inlined — the namespacing three times over (regimes, results,
 * chart_data) — where a subtle prefix/off-by-one bug would silently mis-key the
 * merged roles index, the view catalog, and the geometry channel.
 */

/** The per-step execution outputs Investigate namespaces. */
export interface StepExecLike {
  results?: Record<string, unknown>;
  chart_data?: Record<string, unknown>;
  regimes?: Record<string, unknown>;
}

/** One sub-question result as the orchestrator returns it (structural). */
export interface StepResultLike {
  index: number;
  removed?: boolean;
  result?: { executionResult: StepExecLike } | null;
}

/**
 * Merge ONE per-step map (results | chart_data | regimes) across every LIVE
 * step into a single map whose keys carry the `step_<n>_` prefix (n = index+1).
 * Removed or failed steps (no `result`) contribute nothing. Later steps win a
 * key collision — but collisions can't happen across the distinct prefixes,
 * which is the whole point of the namespacing.
 */
export function mergeStepEntries(
  subs: StepResultLike[],
  pick: (er: StepExecLike) => Record<string, unknown> | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sub of subs) {
    if (sub.removed || !sub.result) continue;
    const prefix = `step_${sub.index + 1}_`;
    for (const [k, v] of Object.entries(pick(sub.result.executionResult) ?? {})) {
      out[`${prefix}${k}`] = v;
    }
  }
  return out;
}

/** A trace step (structural view of TraceStep). */
export interface TraceStepLike {
  stepNo: number;
  question: string;
  status: string;
  degradedReason?: string;
  error?: string;
}

export interface DataQuality {
  degraded: { stepNo: number; question: string; reason?: string }[];
  failed: { stepNo: number; question: string; error?: string }[];
  removed: { stepNo: number; question: string }[];
}

/**
 * Partition trace steps into the degraded/failed/removed surfacing the
 * ResponsePanel renders as a banner. Deterministic, so a degraded/failed/
 * dropped step reaches the user whether or not the composer annotated it.
 */
export function buildDataQuality(steps: TraceStepLike[]): DataQuality {
  return {
    degraded: steps
      .filter((s) => s.status === "degraded")
      .map((s) => ({ stepNo: s.stepNo, question: s.question, reason: s.degradedReason })),
    failed: steps
      .filter((s) => s.status === "failed")
      .map((s) => ({ stepNo: s.stepNo, question: s.question, error: s.error })),
    removed: steps
      .filter((s) => s.status === "removed")
      .map((s) => ({ stepNo: s.stepNo, question: s.question })),
  };
}
