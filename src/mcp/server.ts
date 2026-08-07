/**
 * The MCP server assembly (mcp-server spec §4).
 *
 * `buildMcpServer(deps, audit)` wires tool handlers to the SDK: input
 * validation via zod shapes (the SDK enforces them before the handler runs),
 * one audit line per call (spec §3 cross-cutting defaults), errors surfaced
 * as MCP tool errors with the message — never a stack — and all results
 * returned as a single JSON text block so any host can consume them. Hosts
 * that negotiated the MCP Apps ui extension additionally get dashboard specs
 * as structuredContent for inline rendering (app-ui.ts).
 *
 * Transport-free by design: main.ts attaches stdio, tests attach the SDK's
 * in-memory transport pair.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  RESOURCE_MIME_TYPE,
  RESOURCE_URI_META_KEY,
  getUiCapability,
  registerAppResource,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpDeps } from "./deps";
import { errorCodeOf, type McpErrorCode } from "./errors";
import { sanitizeArgs, type AuditSink } from "./audit";
import {
  DASHBOARD_UI_URI,
  UI_PAYLOAD_KEY,
  dashboardData,
  dashboardDataInput,
  readDashboardAppTemplate,
} from "./app-ui";
import { connectSource, connectSourceInput } from "./tools/connect-source";
import { getSchema, getSchemaInput } from "./tools/get-schema";
import { runSql, runSqlInput } from "./tools/run-sql";
import { analyze, analyzeInput } from "./tools/analyze";
import {
  analyzeStart,
  analyzeStartInput,
  analyzeStatus,
  analyzeStatusInput,
  analyzeResult,
  analyzeResultInput,
  analyzeCancel,
  analyzeCancelInput,
} from "./tools/analyze-async";
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
 * 0.5.0: MCP Apps (SEP-1865) — `ui://hermetic/dashboard` template resource;
 *        analyze/persist_dashboard declare `_meta.ui` and return the spec as
 *        structuredContent to hosts that negotiated the ui extension. The
 *        model-visible JSON text block is unchanged.
 * 0.6.0: background analysis jobs (analyze_start/status/result/cancel) —
 *        the start→long-poll→result shape for hosts that cancel long tool
 *        calls (Claude Desktop chat: hard ~4 min, no progressToken).
 * 0.7.0: `dashboard_data` (app-only visibility) — the iframe's pull channel
 *        for the dashboard payload, working around hosts that strip
 *        structuredContent from ui/notifications/tool-result.
 * 0.8.0: declared-findings manifest (`findings` + `findings_truncated`) on
 *        analyze/analyze_result when findings.mode="on" — the grammar
 *        (envelope/entry fields) is stable; dtype/tag vocabulary is OPEN
 *        by design (rely on structure, never a dtype enum).
 */
export const MCP_SERVER_VERSION = "0.8.0";

interface ToolTextResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
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
  /** Fires when the host sends notifications/cancelled for this request. */
  signal?: AbortSignal;
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
 *
 * `supportsUi` (when supplied) is the MCP-Apps gate: a handler result may
 * carry an iframe payload under UI_PAYLOAD_KEY — it is ALWAYS stripped from
 * the model-visible JSON text, and becomes `structuredContent` only when the
 * connected client negotiated the ui extension (app-ui.ts).
 */
function withAudit<A extends Record<string, unknown>>(
  audit: AuditSink,
  name: string,
  fn: (args: A, extra?: RequestExtra) => Promise<unknown>,
  supportsUi?: () => boolean
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
      let result = await fn(args, extra);
      let uiPayload: Record<string, unknown> | undefined;
      if (result && typeof result === "object" && UI_PAYLOAD_KEY in result) {
        const { [UI_PAYLOAD_KEY]: ui, ...rest } = result as Record<string, unknown>;
        if (ui && typeof ui === "object") uiPayload = ui as Record<string, unknown>;
        result = rest;
      }
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
      const out = jsonResult(result);
      if (uiPayload && supportsUi?.()) {
        out.structuredContent = uiPayload;
        // Diagnosis breadcrumb (inline-render debugging): confirms the UI
        // payload LEFT the server, with its size — so a blank iframe can be
        // attributed to host forwarding, not to hermetic.
        console.error(
          `[mcp-apps] ${name}: ui payload attached as structuredContent ` +
            `(${Math.round(JSON.stringify(uiPayload).length / 1024)}KB)`
        );
      }
      return out;
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

  // MCP Apps (SEP-1865): did the connected client negotiate the ui
  // extension? Read at CALL time (capabilities exist only after initialize);
  // gates structuredContent so text-only hosts never receive megabytes of
  // spec they'd feed to the model.
  const supportsUi = () =>
    getUiCapability(server.server.getClientCapabilities())?.mimeTypes?.includes(
      RESOURCE_MIME_TYPE
    ) === true;

  // One stderr line at initialize naming the host and whether it negotiated
  // the extension — so "why didn't the dashboard render inline?" is
  // answerable from the log instead of by protocol archaeology. (Claude
  // Desktop chat negotiates it; Claude Code and other text-only hosts don't.)
  server.server.oninitialized = () => {
    const host = server.server.getClientVersion();
    console.error(
      `[mcp-apps] host ${host?.name ?? "unknown"}@${host?.version ?? "?"} ` +
        (supportsUi()
          ? "negotiated the ui extension — dashboards render inline"
          : "did not negotiate the ui extension — dashboards stay behind dashboard_url")
    );
  };

  // The pre-declared dashboard template (app-ui.ts): the data-less viewer a
  // host renders in its sandboxed iframe. Registered unconditionally — a
  // host that never negotiated the extension simply never reads it.
  registerAppResource(
    server,
    "hermetic_dashboard",
    DASHBOARD_UI_URI,
    {
      title: "hermetic dashboard viewer",
      description:
        "Interactive dashboard viewer template (MCP Apps). Receives the spec per tool call " +
        "via structuredContent; fully self-contained — no external requests.",
      mimeType: RESOURCE_MIME_TYPE,
      _meta: {
        ui: {
          // The template inlines its fonts as data: URIs (single-file
          // constraint). Claude Desktop's default iframe CSP allows only
          // font-src 'self', which blocks them (renderer log: "Loading the
          // font 'data:font/woff2...' violates ... font-src") — declare the
          // scheme so hosts that honor csp hints stop stripping the fonts.
          // Cosmetic when ignored: text falls back to system fonts.
          csp: { resourceDomains: ["data:"] },
        },
      },
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readDashboardAppTemplate(deps),
        },
      ],
    })
  );

  // Tool→template linkage: nested `_meta.ui` (current spec) plus the flat
  // deprecated key for hosts on the pre-final shape. Harmless metadata to
  // hosts without the extension.
  const dashboardToolMeta = {
    ui: { resourceUri: DASHBOARD_UI_URI },
    [RESOURCE_URI_META_KEY]: DASHBOARD_UI_URI,
  };

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
        "SQL/code for open-ended questions. Takes MINUTES and blocks until done; if your " +
        "host cancels long tool calls (many chat hosts cap at ~4 minutes), use " +
        "analyze_start + analyze_status + analyze_result instead. Cost is reported.",
      inputSchema: analyzeInput,
      _meta: dashboardToolMeta,
    },
    withAudit(
      audit,
      "analyze",
      (args, extra) => {
        const progress = progressReporterFor(extra);
        // Diagnosis breadcrumb: without a progressToken the host cannot
        // extend its tool timeout, and a multi-minute analyze may be
        // cancelled mid-run (Claude Desktop chat: hard 4-minute cap).
        if (!progress) {
          console.error(
            "[analyze] host did not request progress — long runs may hit host-side timeouts"
          );
        }
        return analyze(deps, args, progress, extra?.signal);
      },
      supportsUi
    )
  );

  server.registerTool(
    "dashboard_data",
    {
      description:
        "INTERNAL — the inline dashboard viewer (MCP Apps iframe) fetches its render payload " +
        "with this. Models should NOT call it: the output is the full dashboard spec (large) " +
        "and everything model-relevant is already in the analyze/analyze_result response.",
      inputSchema: dashboardDataInput,
      _meta: { ui: { visibility: ["app"] } },
    },
    withAudit(audit, "dashboard_data", (args) => dashboardData(deps, args), supportsUi)
  );

  server.registerTool(
    "analyze_start",
    {
      description:
        "Start analyze as a BACKGROUND job — returns {job_id} immediately. Use this instead " +
        "of analyze whenever the analysis may run long or your host cancels long tool calls. " +
        "Then call analyze_status (it blocks until there is progress) until status is " +
        "'done', and analyze_result for the full result.",
      inputSchema: analyzeStartInput,
    },
    withAudit(audit, "analyze_start", async (args) => analyzeStart(deps, args))
  );

  server.registerTool(
    "analyze_status",
    {
      description:
        "Progress of a background analysis job. LONG-POLLS: blocks up to wait_seconds " +
        "(default 45) and returns as soon as the stage changes or the job finishes — so " +
        "simply call it again each time it returns with status 'running'. Never treat a " +
        "'running' response as failure.",
      inputSchema: analyzeStatusInput,
    },
    withAudit(audit, "analyze_status", (args) => analyzeStatus(deps, args))
  );

  server.registerTool(
    "analyze_result",
    {
      description:
        "The full result of a finished background analysis job — same shape as analyze " +
        "(summary, headline stats, dashboard link, computed values). If the job is still " +
        "running it waits up to wait_seconds, then reports status; results are kept ~30 " +
        "minutes after completion.",
      inputSchema: analyzeResultInput,
      _meta: dashboardToolMeta,
    },
    withAudit(audit, "analyze_result", (args) => analyzeResult(deps, args), supportsUi)
  );

  server.registerTool(
    "analyze_cancel",
    {
      description:
        "Cancel a running background analysis job: aborts its LLM streams and sandbox. " +
        "Use when the user changes their mind or the question was wrong.",
      inputSchema: analyzeCancelInput,
    },
    withAudit(audit, "analyze_cancel", (args) => analyzeCancel(deps, args))
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
      _meta: dashboardToolMeta,
    },
    withAudit(audit, "persist_dashboard", (args) => persistDashboard(deps, args), supportsUi)
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
