/**
 * MCP Apps wiring (SEP-1865, the io.modelcontextprotocol/ui extension):
 * hosts that support it (Claude Desktop since 2026-01-26, VS Code, Goose)
 * render dashboards INLINE in the chat instead of behind a 127.0.0.1 link.
 *
 * The shape the extension demands: the UI is a PRE-DECLARED `ui://` resource
 * (the data-less standard-profile viewer — lib/export/html-export's app
 * template), and per-call data rides the tool result's `structuredContent`,
 * which the host forwards to the iframe via `ui/notifications/tool-result`
 * WITHOUT adding it to model context. So the model-visible JSON stays exactly
 * the pre-0.5.0 contract while the iframe gets the full spec.
 *
 * Tool handlers attach the iframe's payload under UI_PAYLOAD_KEY; the
 * withAudit wiring (server.ts) always strips it from the text block and
 * promotes it to structuredContent only when the client declared the ui
 * extension capability — a host that never asked pays nothing (the same
 * bargain as progress reporting).
 */
import { z } from "zod";
import { stripInternalState } from "@/lib/export/html-export";
import type { McpDeps } from "./deps";
import { McpToolError } from "./errors";
import { viewUrl } from "./view-url";
import { viewerDistDir } from "./viewer/dist-dir";

/** The pre-declared template resource every dashboard-producing tool points at. */
export const DASHBOARD_UI_URI = "ui://hermetic/dashboard";

/**
 * The private key handlers attach the iframe payload under. Never serialized
 * into the model-visible JSON text block — withAudit lifts it out first.
 */
export const UI_PAYLOAD_KEY = "__ui";

/** The McpDeps slice the template read consumes (see LivenessDeps for the pattern). */
export type AppUiDeps = Pick<McpDeps, "exportAppTemplateHtml">;

/** The viewer build output — the same dist the export assembler reads. */
const DIST = viewerDistDir();

const TEMPLATE_BUILD_HELP =
  "The viewer bundles are not built. Run `pnpm mcp:build-viewer` in the hermetic checkout, " +
  "then read the resource again.";

/**
 * Assemble the app template for resources/read. Not cached: hosts cache by
 * URI, the read is three file reads, and a per-process cache would pin a
 * stale bundle across `pnpm mcp:build-viewer` reruns.
 */
export async function readDashboardAppTemplate(deps: AppUiDeps): Promise<string> {
  try {
    return (await deps.exportAppTemplateHtml({ distDir: DIST })).html;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new McpToolError("execution_failed", TEMPLATE_BUILD_HELP);
    }
    throw err;
  }
}

/**
 * The iframe's data channel, one shape for every dashboard-producing tool.
 * Mirrors the app entry's AppUiPayload (viewer/export-entry.tsx). The spec
 * goes out publish-clean (stripInternalState — same floor as file export).
 */
/** The McpDeps slice dashboard_data consumes. */
export type DashboardDataDeps = Pick<McpDeps, "loadHistoryEntry">;

export const dashboardDataInput = {
  history_id: z.string().describe("The history_id from analyze/analyze_result/persist_dashboard."),
};

/**
 * dashboard_data — the iframe's PULL channel for the dashboard payload.
 *
 * Claude Desktop currently strips `structuredContent` when forwarding
 * `ui/notifications/tool-result` into the MCP Apps iframe (verified: the
 * server logged "ui payload attached (17KB)" while the iframe received the
 * notification with no structuredContent). A direct `tools/call` FROM the
 * iframe has no such lossy hop — its response returns straight over the app
 * bridge. So the iframe, on receiving a payload-less result, extracts
 * `history_id` from the JSON text block and calls this.
 *
 * The payload rides BOTH channels of the response (text and
 * structuredContent) so either surviving is enough. That makes the output
 * large — hence `visibility: ["app"]`: hosts must not offer it to the
 * model, and the description warns any host that ignores visibility.
 */
export async function dashboardData(
  deps: DashboardDataDeps,
  args: { history_id: string }
): Promise<Record<string, unknown>> {
  let entry: Awaited<ReturnType<DashboardDataDeps["loadHistoryEntry"]>>;
  try {
    entry = await deps.loadHistoryEntry(args.history_id);
  } catch {
    throw new McpToolError(
      "invalid_input",
      `No history entry '${args.history_id}'. Pass a history_id from analyze or persist_dashboard.`
    );
  }
  const payload = dashboardUiPayload({
    spec: entry.spec as Parameters<typeof stripInternalState>[0],
    question: typeof entry.meta.question === "string" ? entry.meta.question : null,
    createdAt:
      typeof entry.meta.timestamp === "number"
        ? new Date(entry.meta.timestamp).toISOString()
        : null,
    dashboardUrl: viewUrl(args.history_id),
  });
  return { ...payload, [UI_PAYLOAD_KEY]: payload };
}

export function dashboardUiPayload(input: {
  spec: Parameters<typeof stripInternalState>[0];
  question: string | null;
  createdAt: string | null;
  dashboardUrl: string | null;
}): Record<string, unknown> {
  return {
    spec: stripInternalState(input.spec),
    question: input.question,
    created_at: input.createdAt,
    dashboard_url: input.dashboardUrl,
  };
}
