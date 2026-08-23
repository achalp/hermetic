import { resolve } from "node:path";

/**
 * THE resolver for the built viewer bundle directory (release-path phase 2).
 *
 * Three consumers (the embedded viewer server, the export_dashboard tool,
 * the MCP Apps template) each used to anchor on their own `__dirname` —
 * identical in the checkout (all resolve to src/mcp/viewer/dist), but the
 * .mcpb bundle flattens every module's `__dirname` to the bundle root, where
 * the three anchors would name three DIFFERENT directories. The bundle entry
 * (mcpb-main.ts) pins the real location via HERMETIC_MCP_VIEWER_DIST before
 * anything reads it; in the checkout the env var is unset and the historical
 * layout holds.
 */
export function viewerDistDir(): string {
  return process.env.HERMETIC_MCP_VIEWER_DIST ?? resolve(__dirname, "dist");
}
