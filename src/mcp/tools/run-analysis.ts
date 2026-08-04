/**
 * run_analysis — host-authored Python in the governed sandbox (mcp-server
 * spec §3, pillar: governed execution).
 *
 * The code is authored by the HOST model, so it gets the strict policy the
 * heuristic path can't give it: network "deny" (--network none regardless of
 * what the code looks like) and Docker only. The response returns computed
 * aggregates (`results`, capped `chart_data`) — full `datasets` (row-level
 * materializations) are deliberately withheld: they exist for dashboards,
 * not for host context (boundary invariant, spec §1).
 *
 * The prelude contract is the same one hermetic's own code-gen writes
 * against: read df from the prepared input, put scalars in results{},
 * chart-shaped rows in chart_data{}.
 */
import { z } from "zod";
import type { McpDeps } from "../deps";
import { getSource } from "../sources";

export const runAnalysisInput = {
  source_id: z.string().describe("A CSV source_id from connect_source."),
  python: z
    .string()
    .describe(
      "Python analysis code (pandas/duckdb available). Populate results{} with scalar " +
        "findings and chart_data{} with chart-shaped row lists — same contract as the " +
        "hermetic runtime. No network access is available."
    ),
};

const CHART_ROW_CAP = 200;

function capChartData(chartData: Record<string, unknown>): {
  capped: Record<string, unknown>;
  truncatedKeys: string[];
} {
  const capped: Record<string, unknown> = {};
  const truncatedKeys: string[] = [];
  for (const [k, v] of Object.entries(chartData)) {
    if (Array.isArray(v) && v.length > CHART_ROW_CAP) {
      capped[k] = v.slice(0, CHART_ROW_CAP);
      truncatedKeys.push(k);
    } else {
      capped[k] = v;
    }
  }
  return { capped, truncatedKeys };
}

export async function runAnalysis(
  deps: McpDeps,
  args: { source_id: string; python: string }
): Promise<Record<string, unknown>> {
  const source = getSource(args.source_id);
  if (!source) throw new Error(`Unknown source_id '${args.source_id}'. Call connect_source first.`);
  if (source.kind !== "csv") {
    throw new Error(
      "run_analysis targets CSV sources. For warehouse sources use run_sql (pushdown) or analyze."
    );
  }

  const csvText = await deps.getCSVContent(source.csvId);
  if (!csvText) {
    throw new Error("Source data expired from the store — call connect_source again.");
  }

  const result = await deps.executeSandbox(csvText, args.python, {
    runtime: "docker",
    network: "deny",
    csvId: source.csvId,
  });

  if (!result.success) {
    throw new Error(
      `Execution failed${result.errorKind ? ` (${result.errorKind})` : ""}: ${result.error}`
    );
  }

  const { capped, truncatedKeys } = capChartData(result.chart_data ?? {});
  return {
    source_id: source.id,
    results: result.results ?? {},
    chart_data: capped,
    chart_data_truncated_keys: truncatedKeys,
    execution_ms: result.execution_ms,
    // Traceability for verify_narrative: the numbers below are the grounded set.
    note: "datasets (row-level) are withheld by policy; use analyze for a full dashboard.",
  };
}
