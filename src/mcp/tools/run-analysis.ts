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
import { assertSourceLive } from "./liveness";
import { CHART_ROW_CAP } from "../caps";
import { McpToolError, unknownSource } from "../errors";
import { withToolLog } from "./log";

/** The McpDeps slice run_analysis consumes (see LivenessDeps for the pattern). */
export type RunAnalysisDeps = Pick<
  McpDeps,
  "getCSVContent" | "getGeoJSONContent" | "executeSandbox" | "getWarehouseState" | "getStoredCSV"
>;

export const runAnalysisInput = {
  source_id: z.string().describe("A CSV source_id from connect_source."),
  python: z
    .string()
    .describe(
      "Python analysis code. CONTRACT: (1) load the data yourself — it is a CSV at " +
        "/data/input.csv, e.g. `import pandas as pd; df = pd.read_csv('/data/input.csv')` " +
        "(no `df` is pre-defined); (2) put scalar findings in results{} and chart-shaped " +
        "row lists in chart_data{}; (3) call write_output(results, chart_data) at the end. " +
        "pandas, numpy, duckdb, scipy, matplotlib are installed. No network access. " +
        "Undefined names are rejected before execution, so import everything you use."
    ),
};

// CHART_ROW_CAP is shared with analyze (../caps) — one boundary cap, no drift.
/** Sandbox stderr is unbounded and can quote data — never relay it whole. */
const MAX_ERROR_CHARS = 600;
/** results{} is host-shaped; bound the whole object, not just nested arrays. */
const MAX_RESULTS_CHARS = 20_000;

function capResults(results: Record<string, unknown>): {
  results: Record<string, unknown>;
  results_truncated: boolean;
} {
  const json = JSON.stringify(results);
  if (json.length <= MAX_RESULTS_CHARS) return { results, results_truncated: false };
  const out: Record<string, unknown> = {};
  let used = 0;
  for (const [k, v] of Object.entries(results)) {
    const size = JSON.stringify(v)?.length ?? 0;
    if (used + size > MAX_RESULTS_CHARS) continue;
    out[k] = v;
    used += size;
  }
  return { results: out, results_truncated: true };
}

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
  deps: RunAnalysisDeps,
  args: { source_id: string; python: string }
): Promise<Record<string, unknown>> {
  return withToolLog("run_analysis", { source_id: args.source_id }, () =>
    runAnalysisImpl(deps, args)
  );
}

async function runAnalysisImpl(
  deps: RunAnalysisDeps,
  args: { source_id: string; python: string }
): Promise<Record<string, unknown>> {
  const source = getSource(args.source_id);
  if (!source) throw unknownSource(args.source_id);
  if (source.kind !== "csv") {
    throw new McpToolError(
      "unsupported_source",
      "run_analysis targets CSV sources. For warehouse sources use run_sql (pushdown) or analyze."
    );
  }
  if (source.remote) {
    throw new McpToolError(
      "unsupported_source",
      "run_analysis runs with networking disabled, and this source is a cloud URL that must " +
        "be read over the network. Use analyze — its pipeline reads remote sources under a " +
        "scan budget."
    );
  }
  if (source.pathBased) {
    throw new McpToolError(
      "unsupported_source",
      "This source is a bind-mounted Parquet path with no CSV text in the store. Use " +
        "analyze — its pipeline mounts the path into the sandbox."
    );
  }
  assertSourceLive(deps, source);

  const csvText = await deps.getCSVContent(source.csvId);
  if (!csvText) {
    throw new McpToolError(
      "source_expired",
      "Source data expired from the store — call connect_source again."
    );
  }

  // GeoJSON sources advertise geometry in get_schema; without this the one
  // tool that could use it never receives it (review S11).
  const geojsonContent = source.schema.has_geojson
    ? await deps.getGeoJSONContent(source.csvId)
    : null;

  const result = await deps.executeSandbox(csvText, args.python, {
    runtime: "docker",
    network: "deny",
    csvId: source.csvId,
    geojsonContent,
  });

  if (!result.success) {
    // Truncate: sandbox stderr is raw and can quote data values (review S6).
    const detail = result.error.slice(0, MAX_ERROR_CHARS);
    throw new McpToolError(
      "execution_failed",
      `Execution failed${result.errorKind ? ` (${result.errorKind})` : ""}: ${detail}` +
        (result.error.length > MAX_ERROR_CHARS ? "… (truncated)" : "")
    );
  }

  const { capped, truncatedKeys } = capChartData(result.chart_data ?? {});
  const { results, results_truncated } = capResults(result.results ?? {});
  return {
    source_id: source.id,
    results,
    results_truncated,
    chart_data: capped,
    chart_data_truncated_keys: truncatedKeys,
    execution_ms: result.execution_ms,
    // Traceability for verify_narrative: the numbers below are the grounded set.
    note: "datasets (row-level) are withheld by policy; use analyze for a full dashboard.",
  };
}
