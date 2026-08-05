/**
 * run_sql — execute caller-supplied SQL against a warehouse source
 * (mcp-server spec §3, pillar: scale).
 *
 * Two guards, both code-level (spec §1 — the gate both audited competitors
 * lack): `assertReadOnlySql` BEFORE execution, and a row cap on the result.
 * The tool returns computed rows — that is its purpose — but bounded, so a
 * `SELECT *` cannot flood host context. CSV sources are refused: local-file
 * analysis goes through run_analysis/analyze where compute happens in the
 * sandbox.
 */
import { z } from "zod";
import type { McpDeps } from "../deps";
import { getSource } from "../sources";
import { assertSourceLive } from "./liveness";

export const runSqlInput = {
  source_id: z.string().describe("A warehouse source_id from connect_source."),
  sql: z.string().describe("A single read-only SELECT statement (engine dialect)."),
  max_rows: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Row cap on the returned result (default 200, hard max 1000)."),
};

const DEFAULT_MAX_ROWS = 200;

export async function runSql(
  deps: McpDeps,
  args: { source_id: string; sql: string; max_rows?: number }
): Promise<Record<string, unknown>> {
  const source = getSource(args.source_id);
  if (!source) throw new Error(`Unknown source_id '${args.source_id}'. Call connect_source first.`);
  if (source.kind !== "warehouse") {
    throw new Error(
      "run_sql targets warehouse sources. For CSV sources use analyze (full pipeline) " +
        "or run_analysis (sandboxed Python)."
    );
  }
  assertSourceLive(deps, source);

  // Throws with a descriptive message on anything but a single read-only
  // SELECT — the model gets the reason and can correct.
  deps.assertReadOnlySql(args.sql);

  const cap = args.max_rows ?? DEFAULT_MAX_ROWS;
  const csv = await source.connector.executeSQL(args.sql);
  const parsed = deps.parseCSV(csv);
  const rows = parsed.data.slice(0, cap);

  return {
    source_id: source.id,
    columns: parsed.headers,
    rows,
    row_count_returned: rows.length,
    truncated: parsed.rowCount > cap,
  };
}
