/**
 * Where a persisted analysis can be VIEWED (mcp-server spec §4 M2/M3).
 *
 * M2: links to the web harness (`pnpm dev` from the same directory).
 * M3 replaces the base with the MCP-embedded viewer so the link never
 * depends on a separately running server — this module is the one seam
 * that swap touches.
 */
export function viewUrl(historyId: string): string {
  const base = process.env.HERMETIC_MCP_VIEW_BASE ?? "http://localhost:3000";
  return `${base}/?restore=${historyId}`;
}
