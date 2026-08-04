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
import { sanitizeArgs, type AuditSink } from "./audit";
import { connectSource, connectSourceInput } from "./tools/connect-source";
import { getSchema, getSchemaInput } from "./tools/get-schema";
import { runSql, runSqlInput } from "./tools/run-sql";
import { listSources } from "./sources";

export const MCP_SERVER_NAME = "hermetic";
export const MCP_SERVER_VERSION = "0.1.0";

interface ToolTextResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function jsonResult(value: unknown): ToolTextResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string): ToolTextResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

/**
 * Wrap a tool handler with the audit + error policy while preserving its
 * argument type, so the SDK's schema-derived inference still applies.
 */
function withAudit<A extends Record<string, unknown>>(
  audit: AuditSink,
  name: string,
  fn: (args: A) => Promise<unknown>
): (args: A) => Promise<ToolTextResult> {
  return async (args: A) => {
    const started = Date.now();
    const sourceId = typeof args?.source_id === "string" ? args.source_id : undefined;
    const base = {
      ts: new Date().toISOString(),
      tool: name,
      sourceId,
      args: sanitizeArgs(args ?? {}),
    };
    try {
      const result = await fn(args);
      audit({ ...base, outcome: "ok", durationMs: Date.now() - started });
      return jsonResult(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      audit({
        ...base,
        outcome: "error",
        error: message.slice(0, 500),
        durationMs: Date.now() - started,
      });
      return errorResult(message);
    }
  };
}

export function buildMcpServer(deps: McpDeps, audit: AuditSink): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });

  server.registerTool(
    "connect_source",
    {
      description:
        "Attach a data source (local CSV file or saved warehouse connection) and get a " +
        "source_id plus a schema summary. Data never leaves the machine; responses carry " +
        "schema and statistics only, never raw rows or credentials.",
      inputSchema: connectSourceInput,
    },
    withAudit(audit, "connect_source", (args) => connectSource(deps, args))
  );

  server.registerTool(
    "get_schema",
    {
      description:
        "Rich schema for a connected source: column types with aggregate stats (ranges, " +
        "means, distinct/top values), detected domain, and notable correlations. Use this " +
        "instead of sampling the data — it is cheaper and never exposes rows.",
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
    "list_sources",
    { description: "List sources connected in this session (id, kind, label)." },
    withAudit(audit, "list_sources", async () => ({ sources: listSources() }))
  );

  return server;
}
