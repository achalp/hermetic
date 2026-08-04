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

export function viewUrl(historyId: string): string {
  const base = process.env.HERMETIC_MCP_VIEW_BASE ?? configuredBase ?? "http://localhost:3000";
  return `${base}/?restore=${historyId}`;
}
