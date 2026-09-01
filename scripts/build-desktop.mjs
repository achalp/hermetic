#!/usr/bin/env node
/**
 * Build the Hermetic desktop executable (build log D15 / Phase 0c) for THIS platform.
 * Produces a platform installer/app under src-tauri/target/release/bundle/.
 *
 * Steps:
 *   1. cargo build --release the egress-fetch bin (the §6a remote-read edge) so the
 *      sidecar picks up the RELEASE binary, not debug.
 *   2. `tauri build` — its beforeBuildCommand (pnpm desktop:sidecar) assembles the
 *      Next standalone server + node + assets into src-tauri/sidecar, then Tauri
 *      bundles it as a resource and compiles the shell.
 *
 * Cross-platform release: run this ON each target OS (macOS/Windows/Linux). A single
 * host cannot produce all installers (native webview + code signing are per-OS). The
 * sidecar's `node` is THIS platform's node (build-desktop-sidecar copies process
 * execPath) — a cross-compile must drop in the target-triple node. See README.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { rmSync } from "node:fs";

const ROOT = resolve(import.meta.dirname, "..");
const run = (cmd, args, opts = {}) => {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", ...opts });
};

console.log("[desktop] 1/2 building egress-fetch (release)…");
run("cargo", ["build", "--release", "--locked", "--bin", "egress-fetch"], {
  cwd: resolve(ROOT, "rust", "egress-core"),
});

console.log("[desktop] 2/2 tauri build (assembles the sidecar, bundles the app)…");
// Tauri's resource staging is copy-only — files DELETED from src-tauri/sidecar
// (e.g. the pruned musl prebuilds that crash linuxdeploy) survive in the stale
// staged copies and reach the AppImage. Purge the staging so every bundle is
// rebuilt from the freshly assembled sidecar.
for (const stale of [
  "src-tauri/target/release/sidecar",
  "src-tauri/target/release/bundle/appimage",
  "src-tauri/target/release/bundle/appimage_deb",
]) {
  rmSync(resolve(ROOT, stale), { recursive: true, force: true });
}
run("pnpm", ["exec", "tauri", "build"]);

console.log("\n[desktop] done — see src-tauri/target/release/bundle/");
