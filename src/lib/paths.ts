import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { harnessSlot } from "@/lib/harness-slot";

/**
 * THE owner of hermetic's on-disk layout (modularization M2-C1, spec §3.2
 * HermeticPaths). Before this module the layout was defined by 14
 * independent `process.cwd()`-anchored module constants across three
 * undocumented roots — no single place to discover it, no way to embed the
 * libraries with different roots.
 *
 * The harness supplies the roots at boot (setPathRoots); defaults preserve
 * today's layout exactly. All storage roots in one view:
 *
 *   dataRoot   (default: <cwd>/data)         durable app state
 *     history/ saved-vizs/ cost/ runs/ diagnostics/ schema-cache/ skills/
 *     user_lib/ models/gguf/ bin/ runtime-config.json schedules.json
 *     warehouse-connections.json   ← moved here from <cwd>/.warehouse-connections.json
 *   scratchRoot (default: <tmpdir>/hermetic)  re-creatable working files
 *     csv & geojson uploads, excel-temp/
 *   userRoot   (default: <home>/.hermetic)    per-user cross-project state
 *     parquet/ recent-sources.json sources/
 *   assetRoot  (default: <cwd>)               repo-shipped runtime assets
 *     docker/sandbox/hermetic_runtime   (WS6 bundles this properly)
 */

// HermeticPathRoots is owned by contracts/harness-boot (the slot must not
// import this file); re-exported here for existing consumers.
export type { HermeticPathRoots } from "@/lib/contracts/harness-boot";
import type { HermeticPathRoots } from "@/lib/contracts/harness-boot";

export function defaultPathRoots(): HermeticPathRoots {
  return {
    dataRoot: join(process.cwd(), "data"),
    scratchRoot: join(tmpdir(), "hermetic"),
    userRoot: join(homedir(), ".hermetic"),
    assetRoot: process.cwd(),
  };
}

/** Harness boot: override where hermetic keeps its state. */
export function setPathRoots(roots: Partial<HermeticPathRoots>): void {
  harnessSlot().pathRoots = { ...defaultPathRoots(), ...roots };
}

function roots(): HermeticPathRoots {
  return (harnessSlot().pathRoots ??= defaultPathRoots());
}

export const hermeticPaths = {
  // ── dataRoot ──
  dataDir: () => roots().dataRoot,
  historyDir: () => join(roots().dataRoot, "history"),
  savedVizsDir: () => join(roots().dataRoot, "saved-vizs"),
  costDir: () => join(roots().dataRoot, "cost"),
  runsDir: () => join(roots().dataRoot, "runs"),
  diagnosticsDir: () => join(roots().dataRoot, "diagnostics"),
  schemaCacheDir: () => join(roots().dataRoot, "schema-cache"),
  skillsDir: () => join(roots().dataRoot, "skills"),
  userLibDir: () => join(roots().dataRoot, "user_lib"),
  ggufModelsDir: () => join(roots().dataRoot, "models", "gguf"),
  bundledBinDir: () => join(roots().dataRoot, "bin"),
  runtimeConfigFile: () => join(roots().dataRoot, "runtime-config.json"),
  schedulesFile: () => join(roots().dataRoot, "schedules.json"),
  warehouseConnectionsFile: () => join(roots().dataRoot, "warehouse-connections.json"),
  mcpAuditFile: () => join(roots().dataRoot, "mcp-audit.jsonl"),
  /** Pre-C1 location (repo root, hidden file) — read as migration fallback. */
  legacyWarehouseConnectionsFile: () => join(roots().assetRoot, ".warehouse-connections.json"),
  // ── scratchRoot ──
  scratchDir: () => roots().scratchRoot,
  excelTempDir: () => join(roots().scratchRoot, "excel-temp"),
  // ── userRoot ──
  userDir: () => roots().userRoot,
  parquetCacheDir: () => join(roots().userRoot, "parquet"),
  recentSourcesFile: () => join(roots().userRoot, "recent-sources.json"),
  savedSourcesDir: () => join(roots().userRoot, "sources"),
  // ── assetRoot ──
  sandboxRuntimeAssetsDir: () => join(roots().assetRoot, "docker", "sandbox", "hermetic_runtime"),
  sandboxPreludeFile: () => join(roots().assetRoot, "docker", "sandbox", "prelude.py"),
  sandboxEgressProxyFile: () => join(roots().assetRoot, "docker", "sandbox", "egress-proxy.py"),
} as const;
