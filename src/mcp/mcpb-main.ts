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
import { chmodSync, existsSync } from "node:fs";
import { setPathRoots } from "@/lib/paths";
import { bundledEgressBinRelPath } from "@/lib/release/egress-bin-layout";

const bundleRoot = __dirname;
process.env.HERMETIC_MCP_VIEWER_DIST ??= join(bundleRoot, "viewer-dist");

// The vendored Rust egress-fetch binary (host-side remote-read edge: manifest
// fetch, S3 listing, ranged reads). Same env pin the Tauri sidecar uses, so
// lib/paths needs no bundle-specific logic. `??=` keeps a user override
// authoritative. Zip extraction can drop the exec bit — restore it, best-effort
// (a failure surfaces later as the spawn error, which names the bin path).
const binRel = bundledEgressBinRelPath(process.platform, process.arch);
if (binRel && !process.env.HERMETIC_EGRESS_FETCH_BIN) {
  const bin = join(bundleRoot, ...binRel.split("/"));
  if (existsSync(bin)) {
    try {
      chmodSync(bin, 0o755);
    } catch {
      /* read-only install dir — the bit was set at pack time */
    }
    process.env.HERMETIC_EGRESS_FETCH_BIN = bin;
  }
}

setPathRoots({
  assetRoot: bundleRoot,
  dataRoot: process.env.HERMETIC_DATA_ROOT ?? join(homedir(), ".hermetic", "data"),
});

void import("./main");
