/**
 * verify_narrative — check the numbers in prose against actually-computed
 * values (mcp-server spec §3, pillar: trust).
 *
 * The host passes its draft narrative plus the computed outputs it based it
 * on (the `results`/`chart_data` from run_analysis or analyze artifacts).
 * Every data-like number in the prose must trace to a computed value —
 * anything untraceable is reported so the host can correct or caveat it
 * BEFORE the user sees a fabricated figure. Same engine as hermetic's
 * investigate-mode grounding audit; advisory by design (rounded/derived
 * figures can be legitimate).
 */
import { z } from "zod";
import type { McpDeps } from "../deps";

export const verifyNarrativeInput = {
  prose: z.string().describe("The narrative text to verify."),
  results: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Computed scalar results the narrative is based on (from run_analysis/analyze)."),
  chart_data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Computed chart data the narrative is based on."),
};

export async function verifyNarrative(
  deps: McpDeps,
  args: {
    prose: string;
    results?: Record<string, unknown>;
    chart_data?: Record<string, unknown>;
  }
): Promise<Record<string, unknown>> {
  if (!args.results && !args.chart_data) {
    throw new Error(
      "Provide the computed outputs (`results` and/or `chart_data`) the narrative is based on."
    );
  }
  const grounded = deps.collectGroundedValues(args.results ?? {}, args.chart_data ?? {});
  const report = deps.verifyGrounding({
    narrativeTexts: [args.prose],
    citedSteps: [],
    grounded,
    successfulStepNos: [],
  });
  return {
    ok: report.ok,
    checked_count: report.checkedCount,
    ungrounded: report.ungrounded,
    grounded_value_count: grounded.length,
    advice:
      report.ungrounded.length > 0
        ? "Numbers listed in `ungrounded` could not be traced to any computed value — " +
          "correct them or caveat them before presenting."
        : "All data-like numbers trace to computed values.",
  };
}
