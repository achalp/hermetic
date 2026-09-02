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
 *   3. macOS only: arch-qualify the updater archive's filename (see below).
 *
 * HERMETIC_TAURI_BUNDLES (optional): restrict Tauri's bundle targets, e.g. `nsis`
 * on the Windows release leg — `targets: "all"` would also emit an .msi, and both
 * map to the same windows-x86_64 updater key (buildUpdaterManifest rejects that).
 *
 * Cross-platform release: run this ON each target OS (macOS/Windows/Linux). A single
 * host cannot produce all installers (native webview + code signing are per-OS). The
 * sidecar's `node` is THIS platform's node (build-desktop-sidecar copies process
 * execPath) — a cross-compile must drop in the target-triple node. See README.
 */
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";

const ROOT = resolve(import.meta.dirname, "..");
// pnpm on Windows is a .cmd shim, which Node refuses to spawn without a shell
// (CVE-2024-27980 hardening). Args below are static strings, so shell is safe.
const WIN = process.platform === "win32";
const run = (cmd, args, opts = {}) => {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: WIN && cmd === "pnpm", ...opts });
};

console.log("[desktop] 1/3 building egress-fetch (release)…");
run("cargo", ["build", "--release", "--locked", "--bin", "egress-fetch"], {
  cwd: resolve(ROOT, "rust", "egress-core"),
});

console.log("[desktop] 2/3 tauri build (assembles the sidecar, bundles the app)…");
// Tauri's resource staging is copy-only — files DELETED from src-tauri/sidecar
// (e.g. the pruned musl prebuilds that crash linuxdeploy) survive in the stale
// staged copies and reach the AppImage. Purge the staging so every bundle is
// rebuilt from the freshly assembled sidecar.
for (const stale of [
  "src-tauri/target/release/sidecar",
  "src-tauri/target/release/bundle/appimage",
  "src-tauri/target/release/bundle/appimage_deb",
  "src-tauri/target/release/bundle/dmg",
  "src-tauri/target/release/bundle/macos",
  "src-tauri/target/release/bundle/nsis",
  "src-tauri/target/release/bundle/msi",
]) {
  rmSync(resolve(ROOT, stale), { recursive: true, force: true });
}
const bundles = process.env.HERMETIC_TAURI_BUNDLES;
run("pnpm", ["exec", "tauri", "build", ...(bundles ? ["--bundles", bundles] : [])]);

// 3/3 macOS: Tauri names the updater archive `Hermetic.app.tar.gz` with no
// arch, so the aarch64 and x86_64 release legs would upload colliding assets —
// and platformForBundle() (which keys off the FILENAME) would read both as
// darwin-x86_64. Arch-qualify it (+ its .sig) the way the .dmg already is;
// `Hermetic_aarch64.app.tar.gz` → darwin-aarch64 is pinned by the
// updater-manifest unit tests.
if (process.platform === "darwin") {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const dir = resolve(ROOT, "src-tauri/target/release/bundle/macos");
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    const m = /^(.+?)\.app\.tar\.gz(\.sig)?$/.exec(f);
    if (!m || m[1].includes(arch)) continue;
    const renamed = `${m[1]}_${arch}.app.tar.gz${m[2] ?? ""}`;
    renameSync(join(dir, f), join(dir, renamed));
    console.log(`[desktop] renamed ${f} → ${renamed}`);
  }
}

console.log("\n[desktop] done — see src-tauri/target/release/bundle/");
