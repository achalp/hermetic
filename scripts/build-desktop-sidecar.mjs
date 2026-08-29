#!/usr/bin/env node
/**
 * Assemble the Tauri desktop SIDECAR (build log D15 / Phase 0c): a self-contained
 * dir the Tauri Rust core spawns as `node server.js`, serving the Next standalone
 * app with the WASM runtime (no Docker). Layout (all under OUT):
 *
 *   server.js  .next/  node_modules/     ← the Next standalone output (SSR server)
 *   .next/static  public/                ← static assets copied in (Next requires it)
 *   docker/sandbox/hermetic_runtime/     ← the per-run Python package (asset root)
 *   pyodide/                             ← Pyodide dist, served at /pyodide/*
 *   bin/egress-fetch[.exe]               ← the §6a remote-read edge
 *   node[.exe]                           ← the Node runtime (same-platform: this node)
 *
 * The Tauri spawn sets HERMETIC_ASSET_ROOT=OUT (read-only bundle), the writable
 * roots to an OS app-data dir, HERMETIC_PYODIDE_DIR / HERMETIC_EGRESS_FETCH_BIN, and
 * HERMETIC_SANDBOX_RUNTIME=wasm. Cross-platform release fetches the TARGET node +
 * builds egress-fetch for the target triple (see scripts/build-desktop.mjs / docs).
 */
import { cp, rm, mkdir, stat, chmod, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = process.env.SIDECAR_OUT
  ? resolve(process.env.SIDECAR_OUT)
  : join(ROOT, "src-tauri", "sidecar");
const STANDALONE = join(ROOT, ".next", "standalone");

async function has(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
function log(m) {
  console.log(`[sidecar] ${m}`);
}

async function main() {
  if (!(await has(STANDALONE))) {
    log("no .next/standalone — building (HERMETIC_STANDALONE=1 next build)…");
    execFileSync("pnpm", ["build"], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, HERMETIC_STANDALONE: "1" },
    });
  }

  log(`assembling → ${OUT}`);
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // 1) The standalone server (server.js + its traced node_modules + package.json).
  await cp(STANDALONE, OUT, { recursive: true });
  // 2) Static + public (Next standalone does NOT copy these itself).
  await cp(join(ROOT, ".next", "static"), join(OUT, ".next", "static"), { recursive: true });
  if (await has(join(ROOT, "public")))
    await cp(join(ROOT, "public"), join(OUT, "public"), { recursive: true });
  // 3) Asset root: the per-run Python runtime package (hermeticPaths.sandboxRuntimeAssetsDir).
  await cp(join(ROOT, "docker", "sandbox"), join(OUT, "docker", "sandbox"), { recursive: true });

  // 4) Pyodide dist (served at /pyodide/*). Best-effort: large; warn if absent.
  const pyodide = join(ROOT, "node_modules", "pyodide");
  if (await has(pyodide)) {
    await cp(pyodide, join(OUT, "pyodide"), { recursive: true });
    log("pyodide dist copied");
  } else log("WARN pyodide dist missing — the wasm runtime will 404 /pyodide/*");

  // 5) egress-fetch bin (release preferred, else debug). Warn if not built.
  await mkdir(join(OUT, "bin"), { recursive: true });
  const binName = process.platform === "win32" ? "egress-fetch.exe" : "egress-fetch";
  let copiedBin = false;
  for (const profile of ["release", "debug"]) {
    const src = join(ROOT, "rust", "egress-core", "target", profile, binName);
    if (await has(src)) {
      await copyFile(src, join(OUT, "bin", binName));
      await chmod(join(OUT, "bin", binName), 0o755).catch(() => {});
      log(`egress-fetch (${profile}) copied`);
      copiedBin = true;
      break;
    }
  }
  if (!copiedBin)
    log(
      "WARN egress-fetch not built (cargo build --release -p hermetic-egress-core --bin egress-fetch) — remote sources will fail"
    );

  // 6) The Node runtime. Same-platform: reuse THIS node. Cross-platform release
  // must drop in the target-triple node (documented in build-desktop.mjs).
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  await copyFile(process.execPath, join(OUT, nodeName));
  await chmod(join(OUT, nodeName), 0o755).catch(() => {});
  log(`node runtime copied (${process.execPath})`);

  // A tiny manifest the Rust spawn / docs can read.
  await writeFile(
    join(OUT, "sidecar-manifest.json"),
    JSON.stringify(
      {
        entry: "server.js",
        node: nodeName,
        egressFetchBin: `bin/${binName}`,
        pyodideDir: "pyodide",
        assetRoot: ".",
        builtOn: process.platform,
      },
      null,
      2
    )
  );
  log("done");
}

main().catch((e) => {
  console.error(`[sidecar] FAILED: ${e?.stack || e}`);
  process.exit(1);
});
