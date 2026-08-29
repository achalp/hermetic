import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { harnessSlot, envConfig } from "@/lib/harness-slot";

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
  // Learning loop (specs/learning-loops-2026-08-05.md): candidate ledger,
  // graduated proposals awaiting review, and the verified-exemplar bank.
  learningDir: () => join(roots().dataRoot, "learning"),
  learningLedgerFile: () => join(roots().dataRoot, "learning", "ledger.json"),
  learningProposalsDir: () => join(roots().dataRoot, "learning", "proposals"),
  learningExemplarsDir: () => join(roots().dataRoot, "learning", "exemplars"),
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
  /**
   * The Rust `egress-fetch` binary (build log D9) — the host-side remote-read edge
   * for the WASM runtime. Production (Tauri) sets HERMETIC_EGRESS_FETCH_BIN to the
   * bundled binary; dev falls back to the cargo build output (debug).
   */
  egressFetchBin: () =>
    envConfig().HERMETIC_EGRESS_FETCH_BIN ??
    join(roots().assetRoot, "rust", "egress-core", "target", "debug", "egress-fetch"),
  /**
   * The Pyodide distribution served at `/pyodide/*` for the WASM worker (build log
   * D15). Production (Tauri) sets HERMETIC_PYODIDE_DIR to the bundled dist; dev
   * serves it straight from node_modules.
   */
  pyodideDir: () =>
    envConfig().HERMETIC_PYODIDE_DIR ?? join(roots().assetRoot, "node_modules", "pyodide"),
  /**
   * The DuckDB-WASM browser assets served same-origin at /duckdb/* (build log D18):
   * the classic-worker bundle, the .wasm modules, and the `ext/` extension repository.
   * The worker CSP is `connect-src 'self'`, so extension autoload MUST resolve here —
   * duckdb's default (extensions.duckdb.org) is correctly blocked. Production (Tauri)
   * sets HERMETIC_DUCKDB_DIR to the bundled dir; dev falls back to the build output.
   */
  duckdbWasmDir: () =>
    envConfig().HERMETIC_DUCKDB_DIR ?? join(roots().assetRoot, "public", "duckdb-wasm"),
} as const;
