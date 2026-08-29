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
import { existsSync, renameSync } from "node:fs";
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

/**
 * Build the Next standalone with `data/` moved ASIDE. The Turbopack standalone
 * tracer (Next 16) copies the whole `data/` dir — runtime state incl. multi-GB model
 * GGUFs — into .next/standalone, ignoring outputFileTracingExcludes; that fills the
 * disk and bloats the bundle. An atomic rename (same fs) keeps it out of the trace
 * root; a finally + signal handlers ALWAYS restore it (never strand a user's history).
 */
function buildStandaloneWithoutData() {
  // Turbopack (Next 16) standalone tracing copies the whole repo subtree, ignoring
  // outputFileTracingExcludes — so RUNTIME STATE (data/: multi-GB models, history)
  // and BUILD ARTIFACTS (rust/ + src-tauri/ target dirs, a prior sidecar assembly)
  // would be copied into .next/standalone, filling the disk. Move each aside with an
  // atomic rename (same fs) for the build; a finally + signal handlers ALWAYS
  // restore, so a user's data/ (history) is never stranded.
  const asides = ["data", "rust", "src-tauri"]
    .map((rel) => ({
      dir: join(ROOT, rel),
      bak: join(ROOT, `.${rel.replace(/\//g, "-")}-build-bak`),
    }))
    .filter((a) => existsSync(a.dir));
  const restore = () => {
    for (const a of asides) {
      try {
        if (existsSync(a.bak)) renameSync(a.bak, a.dir);
      } catch (e) {
        console.error(`[sidecar] WARN could not restore ${a.dir} from ${a.bak}: ${e}`);
      }
    }
  };
  for (const a of asides) {
    if (existsSync(a.bak)) throw new Error(`${a.bak} already exists — restore it before building`);
    renameSync(a.dir, a.bak);
  }
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => (restore(), process.exit(1)));
  try {
    execFileSync("pnpm", ["build"], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, HERMETIC_STANDALONE: "1" },
    });
  } finally {
    restore();
  }
}

async function main() {
  if (!(await has(STANDALONE))) {
    log("no .next/standalone — building (data/ moved aside)…");
    buildStandaloneWithoutData();
  }

  log(`assembling → ${OUT}`);
  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  // 1) The standalone server (server.js + its traced node_modules + package.json).
  await cp(STANDALONE, OUT, { recursive: true });
  // 1b) Post-clean: drop any RUNTIME/dev dirs Turbopack over-traced into the bundle
  // (belt-and-suspenders to the move-aside — it ignores outputFileTracingExcludes).
  for (const junk of [
    "data",
    ".git",
    "test-fixtures",
    "e2e",
    "coverage",
    "playwright-report",
    "src-tauri", // Rust target + a prior sidecar assembly — recursive multi-GB bloat
    "rust", // egress-core target (the bin is copied to bin/ below)
    "docs",
    join("node_modules", ".cache"),
  ]) {
    await rm(join(OUT, junk), { recursive: true, force: true });
  }
  // 1c) Ensure @duckdb/duckdb-wasm is present (host-side parquet→CSV requires it at
  // runtime via createRequire; the tracer may miss the dynamic require).
  const dd = join("node_modules", "@duckdb", "duckdb-wasm");
  if (!(await has(join(OUT, dd))) && (await has(join(ROOT, dd)))) {
    await cp(join(ROOT, dd), join(OUT, dd), { recursive: true });
    log("@duckdb/duckdb-wasm ensured in bundle");
  }
  // 2) Static + public (Next standalone does NOT copy these itself).
  await cp(join(ROOT, ".next", "static"), join(OUT, ".next", "static"), { recursive: true });
  if (await has(join(ROOT, "public")))
    await cp(join(ROOT, "public"), join(OUT, "public"), { recursive: true });
  // 3) Asset root: the per-run Python runtime package (hermeticPaths.sandboxRuntimeAssetsDir).
  await cp(join(ROOT, "docker", "sandbox"), join(OUT, "docker", "sandbox"), { recursive: true });

  // 4) Pyodide dist (served at /pyodide/*). Best-effort: large; warn if absent.
  //    SIDECAR_SKIP_PYODIDE=1 skips the ~200MB copy (CI smoke of server boot only).
  const pyodide = join(ROOT, "node_modules", "pyodide");
  if (process.env.SIDECAR_SKIP_PYODIDE === "1") {
    log("SKIP pyodide copy (SIDECAR_SKIP_PYODIDE=1) — server-boot smoke only");
  } else if (await has(pyodide)) {
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
