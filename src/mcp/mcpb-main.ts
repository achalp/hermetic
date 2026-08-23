/**
 * The .mcpb bundle entry (release-path phase 2; distribution channel #1).
 *
 * esbuild flattens the whole server into one CJS file at the bundle root, so
 * an installed bundle has neither the checkout's directory shape nor a
 * meaningful working directory (Claude Desktop spawns it from an arbitrary
 * cwd). Before ANY lib module resolves a path, this entry pins the roots for
 * the installed layout via the harness-boot seam (lib/paths setPathRoots):
 *
 *   assetRoot   → the bundle dir — docker/sandbox/hermetic_runtime,
 *                 prelude.py, egress-proxy.py ship inside the bundle
 *   dataRoot    → ~/.hermetic/data (HERMETIC_DATA_ROOT overrides — the
 *                 smoke test uses that to keep runs hermetic)
 *   viewer dist → <bundle>/viewer-dist via HERMETIC_MCP_VIEWER_DIST
 *                 (see viewer/dist-dir.ts for why an env pin is needed)
 *
 * Then boots the ordinary stdio server — main.ts self-executes on import,
 * and the import is dynamic so nothing loads before the roots are set.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import { setPathRoots } from "@/lib/paths";

const bundleRoot = __dirname;
process.env.HERMETIC_MCP_VIEWER_DIST ??= join(bundleRoot, "viewer-dist");
setPathRoots({
  assetRoot: bundleRoot,
  dataRoot: process.env.HERMETIC_DATA_ROOT ?? join(homedir(), ".hermetic", "data"),
});

void import("./main");
