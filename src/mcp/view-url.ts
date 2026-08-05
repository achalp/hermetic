/**
 * Where a persisted analysis can be VIEWED (mcp-server spec §4 M2/M3).
 *
 * Default: the MCP-embedded viewer (main.ts sets the base once its server is
 * listening) — links never depend on `pnpm dev` running. Override with
 * HERMETIC_MCP_VIEW_BASE to point at the full web app instead (its restore
 * route renders the same entries with the complete app chrome).
 */
let configuredBase: string | null = null;

export function setViewUrlBase(base: string): void {
  configuredBase = base;
}

function base(): string {
  return process.env.HERMETIC_MCP_VIEW_BASE ?? configuredBase ?? "http://localhost:3000";
}

export function viewUrl(historyId: string): string {
  return `${base()}/?restore=${historyId}`;
}

/**
 * The single-file HTML download for a persisted entry
 * (specs/dashboard-distribution-2026-08-05.md §4.2) — same base as viewUrl,
 * so the link resolves against whichever surface is serving the dashboards.
 */
export function exportUrl(historyId: string): string {
  return `${base()}/api/export/${historyId}`;
}
