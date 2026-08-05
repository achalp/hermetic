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
import { getSource } from "../sources";

export const verifyNarrativeInput = {
  prose: z.string().describe("The narrative text to verify."),
  source_id: z
    .string()
    .optional()
    .describe(
      "Verify against the values HERMETIC computed for this source's last analysis " +
        "(server-side truth). STRONGLY preferred over passing results/chart_data yourself — " +
        "self-supplied values only check the prose against itself."
    ),
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
    source_id?: string;
    results?: Record<string, unknown>;
    chart_data?: Record<string, unknown>;
  }
): Promise<Record<string, unknown>> {
  // Server-side anchor (review S5): with a source_id the grounded set comes
  // from hermetic's own artifacts cache, so a host cannot validate its prose
  // against numbers it invented.
  let results = args.results;
  let chartData = args.chart_data;
  let anchor: "server" | "caller-supplied" = "caller-supplied";
  if (args.source_id) {
    const source = getSource(args.source_id);
    if (!source) throw new Error(`Unknown source_id '${args.source_id}'.`);
    if (source.kind !== "csv") {
      throw new Error(
        "Server-side verification needs a source whose analysis hermetic computed " +
          "(non-warehouse). Pass results/chart_data explicitly for warehouse sources."
      );
    }
    const cached = deps.getCachedArtifacts(source.csvId);
    if (!cached) {
      throw new Error(
        "No computed analysis is cached for this source — run analyze first, or pass " +
          "results/chart_data explicitly."
      );
    }
    results = cached.results;
    chartData = cached.chart_data;
    anchor = "server";
  }
  if (!results && !chartData) {
    throw new Error(
      "Provide `source_id` (preferred — verifies against hermetic's own computed values) " +
        "or the computed outputs (`results` and/or `chart_data`) the narrative is based on."
    );
  }
  const grounded = deps.collectGroundedValues(results ?? {}, chartData ?? {});
  const report = deps.verifyGrounding({
    narrativeTexts: [args.prose],
    citedSteps: [],
    grounded,
    successfulStepNos: [],
  });
  return {
    ok: report.ok,
    anchor,
    checked_count: report.checkedCount,
    ungrounded: report.ungrounded,
    grounded_value_count: grounded.length,
    advice:
      anchor === "caller-supplied" && report.ungrounded.length === 0
        ? "All numbers trace to the values YOU supplied — pass `source_id` to verify " +
          "against hermetic's own computed values instead."
        : report.ungrounded.length > 0
          ? "Numbers listed in `ungrounded` could not be traced to any computed value — " +
            "correct them or caveat them before presenting."
          : "All data-like numbers trace to computed values.",
  };
}
