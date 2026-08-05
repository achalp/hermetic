/**
 * The MCP server assembly (mcp-server spec §4).
 *
 * `buildMcpServer(deps, audit)` wires tool handlers to the SDK: input
 * validation via zod shapes (the SDK enforces them before the handler runs),
 * one audit line per call (spec §3 cross-cutting defaults), errors surfaced
 * as MCP tool errors with the message — never a stack — and all results
 * returned as a single JSON text block so any host can consume them.
 *
 * Transport-free by design: main.ts attaches stdio, tests attach the SDK's
 * in-memory transport pair.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpDeps } from "./deps";
import { errorCodeOf, type McpErrorCode } from "./errors";
import { sanitizeArgs, type AuditSink } from "./audit";
import { connectSource, connectSourceInput } from "./tools/connect-source";
import { getSchema, getSchemaInput } from "./tools/get-schema";
import { runSql, runSqlInput } from "./tools/run-sql";
import { analyze, analyzeInput } from "./tools/analyze";
import { runAnalysis, runAnalysisInput } from "./tools/run-analysis";
import { verifyNarrative, verifyNarrativeInput } from "./tools/verify-narrative";
import { persistDashboard, persistDashboardInput } from "./tools/persist-dashboard";
import { exportDashboard, exportDashboardInput } from "./tools/export-dashboard";
import { listSources } from "./sources";

export const MCP_SERVER_NAME = "hermetic";
/**
 * The contract version of the tool surface (RPC hygiene, spec §8). Reported
 * in the MCP initialize handshake and by list_sources, so a host can tell
 * which contract it is talking to from tool space too. Bump MINOR for
 * additive response fields, MAJOR for anything a host could break on.
 * 0.2.0: error `code` taxonomy; `truncated_columns` flags.
 * 0.3.0: analyze returns `run_id` (joins the audit line and server logs).
 * 0.4.0: `export_dashboard` tool (single-file HTML export); analyze returns
 *        `export_url` (the same download link) beside `dashboard_url`.
 */
export const MCP_SERVER_VERSION = "0.4.0";

interface ToolTextResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function jsonResult(value: unknown): ToolTextResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string, code: McpErrorCode): ToolTextResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message, code }) }],
    isError: true,
  };
}

/**
 * The SDK's per-request context: carries the caller's progressToken (when the
 * host asked for progress) and the channel to push notifications on.
 */
interface RequestExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

/**
 * A progress reporter bound to one request, or undefined when the host did
 * not request progress. Long tools (analyze runs for minutes) must not leave
 * the host blind — and a host that never asked pays nothing.
 */
export function progressReporterFor(extra: RequestExtra | undefined) {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if (token === undefined || !send) return undefined;
  // Monotonic fallback so a host rendering a bar still advances when the
  // pipeline reports stages without step/total.
  let tick = 0;
  return (p: { stage: string; detail?: string; step?: number; total?: number }) => {
    const message = p.detail ? `${p.stage} — ${p.detail}` : p.stage;
    const progress = typeof p.step === "number" ? p.step : ++tick;
    const total = typeof p.total === "number" ? p.total : undefined;
    void send({
      method: "notifications/progress",
      params: { progressToken: token, progress, total, message },
    }).catch(() => {
      // A host that stopped listening must never fail the tool call.
    });
  };
}

/**
 * Wrap a tool handler with the audit + error policy while preserving its
 * argument type, so the SDK's schema-derived inference still applies.
 */
function withAudit<A extends Record<string, unknown>>(
  audit: AuditSink,
  name: string,
  fn: (args: A, extra?: RequestExtra) => Promise<unknown>
): (args: A, extra?: RequestExtra) => Promise<ToolTextResult> {
  return async (args: A, extra?: RequestExtra) => {
    const started = Date.now();
    const sourceId = typeof args?.source_id === "string" ? args.source_id : undefined;
    const base = {
      ts: new Date().toISOString(),
      tool: name,
      sourceId,
      args: sanitizeArgs(args ?? {}),
    };
    try {
      const result = await fn(args, extra);
      // A tool that ran a pipeline reports its run_id in the result (analyze)
      // — stamp it into the audit line so the call joins the run's logs.
      const runId =
        result && typeof (result as { run_id?: unknown }).run_id === "string"
          ? ((result as { run_id: string }).run_id as string)
          : undefined;
      audit({
        ...base,
        ...(runId ? { runId } : {}),
        outcome: "ok",
        durationMs: Date.now() - started,
      });
      return jsonResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = errorCodeOf(err);
      audit({
        ...base,
        outcome: "error",
        error: message.slice(0, 500),
        code,
        durationMs: Date.now() - started,
      });
      return errorResult(message, code);
    }
  };
}

export function buildMcpServer(deps: McpDeps, audit: AuditSink): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

  server.registerTool(
    "connect_source",
    {
      description:
        "Attach a data source and get a source_id plus a schema summary. Accepts: `path` " +
        "(local .csv, .xlsx [use `sheet` for multi-sheet], GeoJSON, .parquet file, or " +
        "Parquet folder), `url` (cloud Parquet — s3://, https://, gs://, incl. " +
        "Hive-partitioned prefixes), or `connection_id` (saved warehouse). Data never " +
        "leaves the machine; responses carry schema and statistics only, never raw rows " +
        "or credentials.",
      inputSchema: connectSourceInput,
    },
    withAudit(audit, "connect_source", (args) => connectSource(deps, args))
  );

  server.registerTool(
    "get_schema",
    {
      description:
        "Schema for a connected source, plus which tools that source supports. FILE/CLOUD " +
        "sources return aggregate stats (ranges, means, distinct/top values), detected " +
        "domain, and correlations — use it instead of sampling rows. WAREHOUSE sources " +
        "return table and column names/types only (no stats); to characterize warehouse " +
        "data, aggregate it with run_sql rather than SELECTing rows.",
      inputSchema: getSchemaInput,
    },
    withAudit(audit, "get_schema", (args) => getSchema(args))
  );

  server.registerTool(
    "run_sql",
    {
      description:
        "Execute a single read-only SELECT against a WAREHOUSE source (pushdown — works at " +
        "billions of rows). Non-SELECT statements are rejected before execution. Results " +
        "are row-capped; prefer aggregating in SQL.",
      inputSchema: runSqlInput,
    },
    withAudit(audit, "run_sql", (args) => runSql(deps, args))
  );

  server.registerTool(
    "analyze",
    {
      description:
        "Run hermetic's full analysis pipeline on a source: generates and executes analysis " +
        "code in a sandbox, composes an interactive dashboard, persists it, and returns a " +
        "summary + a link to view it. The flagship tool — prefer this over hand-rolling " +
        "SQL/code for open-ended questions. Takes seconds to minutes; cost is reported.",
      inputSchema: analyzeInput,
    },
    withAudit(audit, "analyze", (args, extra) => analyze(deps, args, progressReporterFor(extra)))
  );

  server.registerTool(
    "run_analysis",
    {
      description:
        "Execute YOUR OWN Python analysis code against a CSV source in hermetic's Docker " +
        "sandbox — no network access, no host filesystem. Read the data from " +
        "/data/input.csv (nothing is pre-loaded), fill results{}/chart_data{}, and end " +
        "with write_output(results, chart_data). Returns computed aggregates only. " +
        "Prefer analyze for open-ended questions.",
      inputSchema: runAnalysisInput,
    },
    withAudit(audit, "run_analysis", (args) => runAnalysis(deps, args))
  );

  server.registerTool(
    "verify_narrative",
    {
      description:
        "Check every data-like number in a draft narrative against real computed values. " +
        "Pass `source_id` to verify against HERMETIC's own artifacts (server-side truth — " +
        "preferred); passing results/chart_data yourself only checks your prose against " +
        "numbers you supplied. Returns untraceable figures so you can correct or caveat " +
        "them before presenting.",
      inputSchema: verifyNarrativeInput,
    },
    withAudit(audit, "verify_narrative", (args) => verifyNarrative(deps, args))
  );

  server.registerTool(
    "persist_dashboard",
    {
      description:
        "Persist a dashboard spec YOU authored as a permanent, viewable analysis (returns the " +
        "link). The spec must validate against hermetic's component catalog — invalid specs " +
        "are rejected with the reason. Prefer analyze unless you are deliberately composing " +
        "the dashboard yourself.",
      inputSchema: persistDashboardInput,
    },
    withAudit(audit, "persist_dashboard", (args) => persistDashboard(deps, args))
  );

  server.registerTool(
    "export_dashboard",
    {
      description:
        "Export a persisted dashboard as ONE self-contained .html file — data, charts, and " +
        "full interactivity inlined; opens in any browser from file://, offline, no install. " +
        "Use when the user wants to share, send, or download a dashboard. Takes the " +
        "history_id from analyze/persist_dashboard; returns the written file's path and a " +
        "local download link.",
      inputSchema: exportDashboardInput,
    },
    withAudit(audit, "export_dashboard", (args) => exportDashboard(deps, args))
  );

  server.registerTool(
    "list_sources",
    { description: "List sources connected in this session (id, kind, label)." },
    withAudit(audit, "list_sources", async () => ({
      contract_version: MCP_SERVER_VERSION,
      sources: listSources(),
    }))
  );

  return server;
}
