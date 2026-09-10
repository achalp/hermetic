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
import { cp, rm, mkdir, stat, chmod, writeFile, copyFile, readdir } from "node:fs/promises";
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
  // src-tauri CANNOT be moved aside on Windows: this script runs as `tauri
  // build`'s beforeBuildCommand, and the live tauri process holds handles
  // into src-tauri — Windows refuses the rename (EBUSY; broke the v0.3.0-rc.1
  // windows leg). Turbopack then traces src-tauri into the standalone, but on
  // a fresh CI runner it is only sources + icons (target/ doesn't exist until
  // tauri compiles, AFTER this hook) and the post-clean below removes it from
  // OUT. A Windows dev machine with a fat src-tauri/target pays a slow copy —
  // accepted; the other asides (data, rust) still move.
  const asides = ["data", "rust", ...(process.platform === "win32" ? [] : ["src-tauri"])]
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
      // .cmd shim on Windows — Node refuses to spawn it without a shell.
      shell: process.platform === "win32",
      env: { ...process.env, HERMETIC_STANDALONE: "1" },
    });
  } finally {
    restore();
  }
}

/** Does the package's declared entry (main / index.js / an exports target) exist on disk? */
async function entryPresent(pkgDir, pj) {
  const cands = [];
  if (typeof pj.main === "string") cands.push(pj.main, `${pj.main}.js`, join(pj.main, "index.js"));
  const dot = pj.exports && (typeof pj.exports === "string" ? pj.exports : pj.exports?.["."]);
  const dotFile =
    typeof dot === "string" ? dot : dot && (dot.require || dot.import || dot.default || dot.node);
  if (typeof dotFile === "string") cands.push(dotFile);
  if (!pj.main && !pj.exports) cands.push("index.js");
  for (const c of cands) if (await has(join(pkgDir, c.replace(/^\.\//, "")))) return true;
  return false;
}

/** Recursively find + repair traced packages missing their files (see caller). */
async function repairIncompletePackages(outNm, srcNm, rel = "") {
  const { readdir, readFile } = await import("node:fs/promises");
  let entries;
  try {
    entries = await readdir(join(outNm, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const name = e.name;
    if (rel === "" && name.startsWith("@")) {
      await repairIncompletePackages(outNm, srcNm, name); // scope dir → recurse one level
      continue;
    }
    const pkgRel = rel ? `${rel}/${name}` : name;
    const outPkg = join(outNm, pkgRel);
    const pjPath = join(outPkg, "package.json");
    if (!(await has(pjPath))) continue;
    let pj;
    try {
      pj = JSON.parse(await readFile(pjPath, "utf8"));
    } catch {
      continue;
    }
    const onlyManifest =
      (await import("node:fs/promises").then((m) => m.readdir(outPkg))).length === 1;
    if (onlyManifest || !(await entryPresent(outPkg, pj))) {
      const srcPkg = join(srcNm, pkgRel);
      if (await has(srcPkg)) {
        await rm(outPkg, { recursive: true, force: true });
        await cp(srcPkg, outPkg, { recursive: true, dereference: true });
        log(`repaired incomplete package: ${pkgRel}`);
      }
    }
  }
}

/**
 * Remove DANGLING symlinks left in the assembled tree (build log D22).
 *
 * Next 16 Turbopack materializes its hashed external modules as symlinks under
 * `.next/node_modules/`, pointing at ABSOLUTE paths in the build machine's
 * `.next/standalone/node_modules/…`:
 *
 *   @napi-rs/keyring-77f6e008788a8a96 -> /abs/path/.next/standalone/node_modules/@napi-rs/keyring
 *
 * Those targets are outside the bundle, so every one of them dangles the moment the
 * standalone dir is cleaned or the bundle is moved to another machine. `tauri build`
 * then aborts resolving its resource glob:
 *
 *   resource path `sidecar/.next/node_modules/@napi-rs/keyring-…` doesn't exist
 *
 * They are safe to delete: the hashed-externals preload hook (D16) resolves those
 * specifiers by stripping the `-<16hex>` suffix and loading the real package from
 * `node_modules/`, and repairIncompletePackages() has already ensured that package
 * is complete. The desktop-sidecar smoke test asserts a boot with ZERO external-load
 * errors, which is what keeps this honest.
 *
 * Returns the removed paths so the assembly can report them rather than silently
 * mutating the tree.
 */
async function pruneDanglingSymlinks(dir, removed = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isSymbolicLink()) {
      // stat() follows the link: ENOENT ⇒ the target is gone.
      try {
        await stat(full);
      } catch {
        await rm(full, { force: true });
        removed.push(full);
      }
    } else if (e.isDirectory()) {
      await pruneDanglingSymlinks(full, removed);
    }
  }
  return removed;
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
    // The mcpb assembly + CI's downloaded egress-bins (the desktop legs stage
    // them at dist/egress-bins pre-build). Traced in, the stray unsigned
    // darwin bin failed mac notarization (v0.5.2-rc.2) — the REAL bin ships
    // at bin/ below.
    "dist",
    join("node_modules", ".cache"),
  ]) {
    await rm(join(OUT, junk), { recursive: true, force: true });
  }
  // 1c-pre) Prune FOREIGN-NATIVE artifacts. pnpm installs the *-musl / other-
  // arch sibling prebuilds (installers predating optionalDependencies' `libc`
  // field take them all), and ONE musl .node in the tree is fatal to AppImage
  // bundling: linuxdeploy ldd's every ELF it meets and aborts on the musl
  // loader — the bare "failed to run linuxdeploy" this build died with. None
  // of these can ever load under this platform's glibc, so removal is
  // behavior-free (the napi loaders probe gnu first and never fall through).
  await pruneForeignNative(join(OUT, "node_modules"));

  // 1c) REPAIR incomplete externalized packages. Turbopack's standalone tracer copies
  // an external package's package.json but NOT its files (pg, rimraf, @napi-rs/keyring,
  // snowflake-sdk, …) — so the server crashes at runtime ("Cannot find module
  // .../rimraf/rimraf.js"). For every traced package whose entry file is missing (or
  // whose dir holds ONLY package.json), copy the COMPLETE package from source. Surgical
  // — only the ~dozen broken externals are refilled, so the bundle stays ~small.
  await repairIncompletePackages(join(OUT, "node_modules"), join(ROOT, "node_modules"));
  // 2) Static + public (Next standalone does NOT copy these itself).
  await cp(join(ROOT, ".next", "static"), join(OUT, ".next", "static"), { recursive: true });
  // 2-pre) The browser DuckDB engine served at /duckdb/* — the engine behind
  // EVERY remote read on the wasm runtime. Its build output is gitignored and
  // was invoked by NOTHING, so every CI-built desktop bundle shipped without
  // it and cloud connects failed on install (found on the first real mac
  // install, v0.5.2). Build it here, then fail LOUDLY if it still isn't there.
  log("building duckdb-wasm browser assets (/duckdb/*)…");
  execFileSync(process.execPath, [join(ROOT, "scripts", "build-duckdb-wasm-assets.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (await has(join(ROOT, "public")))
    await cp(join(ROOT, "public"), join(OUT, "public"), { recursive: true });
  if (!(await has(join(OUT, "public", "duckdb-wasm", "duckdb-bundle.js")))) {
    throw new Error(
      "sidecar is missing public/duckdb-wasm/duckdb-bundle.js — remote reads would fail on install"
    );
  }
  // 3) Asset root: the per-run Python runtime package (hermeticPaths.sandboxRuntimeAssetsDir).
  await cp(join(ROOT, "docker", "sandbox"), join(OUT, "docker", "sandbox"), { recursive: true });

  // 4) Pyodide dist (served at /pyodide/*). Best-effort: large; warn if absent.
  //    SIDECAR_SKIP_PYODIDE=1 skips the copy (CI smoke of server boot only).
  const pyodide = join(ROOT, "node_modules", "pyodide");
  if (process.env.SIDECAR_SKIP_PYODIDE === "1") {
    log("SKIP pyodide copy (SIDECAR_SKIP_PYODIDE=1) — server-boot smoke only");
  } else if (await has(pyodide)) {
    // The npm dist ships WITHOUT the scientific wheels (they CDN-cache into
    // the dist on first Node loadPackage) — dev machines had them from old
    // test runs, fresh CI runners did not, and every packaged app shipped a
    // Pyodide that could not `import pandas` offline (v0.5.4, mac
    // sidecar.log). Ensure them, copy, then FAIL rather than ship without.
    execFileSync(process.execPath, [join(ROOT, "scripts", "ensure-pyodide-wheels.mjs")], {
      cwd: ROOT,
      stdio: "inherit",
    });
    await cp(pyodide, join(OUT, "pyodide"), { recursive: true, dereference: true });
    const shipped = await readdir(join(OUT, "pyodide"));
    for (const pkg of ["numpy", "pandas", "scipy"]) {
      if (!shipped.some((f) => f.startsWith(`${pkg}-`) && f.endsWith(".whl"))) {
        throw new Error(`sidecar pyodide dist is missing the ${pkg} wheel — wasm would break`);
      }
    }
    log("pyodide dist copied (wheels verified: numpy, pandas, scipy)");
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

  // 7) The hashed-externals preload hook (build log D16): the Tauri sidecar runs
  // `node --require ./hash-externals-hook.cjs server.js` to work around the Next 16
  // Turbopack production external-module bug. Both files must sit next to server.js.
  for (const f of ["hash-externals-hook.cjs", "hash-externals-hook.mjs"]) {
    await copyFile(join(ROOT, "scripts", "desktop", f), join(OUT, f));
  }
  log("hashed-externals hook copied");

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
  // Must run LAST: earlier steps copy trees in, and a dangling link anywhere under
  // OUT breaks `tauri build`'s resource resolution (D22).
  const pruned = await pruneDanglingSymlinks(OUT);
  if (pruned.length > 0) {
    log(
      `pruned ${pruned.length} dangling symlink(s): ` +
        pruned.map((p) => p.slice(OUT.length + 1)).join(", ")
    );
  }

  // macOS release legs: Developer-ID sign every Mach-O INSIDE the sidecar
  // BEFORE Tauri seals the outer .app. Tauri signs the app's own binaries but
  // not executables under Resources/, and notarization rejects any unsigned
  // Mach-O in the bundle ("not signed with a valid Developer ID certificate"
  // — the v0.5.2-rc.1 failure). The identity comes from the workflow's cert
  // import step (HERMETIC_MAC_SIGN_IDENTITY); absent locally, this is a no-op.
  if (process.platform === "darwin" && process.env.HERMETIC_MAC_SIGN_IDENTITY) {
    await signSidecarMachOs(OUT, process.env.HERMETIC_MAC_SIGN_IDENTITY);
  }

  log("done");
}

/**
 * Find and Developer-ID-sign EVERY Mach-O in the sidecar tree. Detection is a
 * full walk with magic-byte checks — never extensions: `.node` addons,
 * sharp's `.dylib`s, extensionless bins, and whatever the next dependency
 * ships all get caught the same way (v0.5.2-rc.2 failed notarization on a
 * `.dylib` an extension-based sweep missed). `node` gets JIT entitlements (V8
 * under the hardened runtime); everything else is signed with an empty
 * entitlement set. Signing failures are FATAL: an unsigned Mach-O means
 * notarization rejects the whole app twenty minutes later with a worse
 * message.
 */
async function signSidecarMachOs(out, identity) {
  const MACHO_MAGICS = new Set([
    "feedface", // 32-bit
    "feedfacf", // 64-bit
    "cafebabe", // universal
    "cffaedfe", // 64-bit little-endian on disk
    "cefaedfe", // 32-bit little-endian on disk
  ]);
  const { open } = await import("node:fs/promises");
  const isMachO = async (p) => {
    try {
      const fd = await open(p, "r");
      const buf = Buffer.alloc(4);
      const { bytesRead } = await fd.read(buf, 0, 4, 0);
      await fd.close();
      return bytesRead === 4 && MACHO_MAGICS.has(buf.toString("hex"));
    } catch {
      return false;
    }
  };

  const machos = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && (await isMachO(full))) machos.push(full);
    }
  }
  await walk(out);

  const entitlements = join(ROOT, "scripts", "desktop", "sidecar-node.entitlements");
  for (const file of machos) {
    const args = ["--force", "--options", "runtime", "--timestamp", "--sign", identity];
    if (file === join(out, "node")) args.push("--entitlements", entitlements);
    execFileSync("codesign", [...args, file], { stdio: "inherit" });
  }
  log(`signed ${machos.length} sidecar Mach-O binaries as "${identity}" (hardened runtime)`);
  if (machos.length < 2) {
    // node + egress-fetch at minimum — fewer means the walk missed something.
    throw new Error(`expected to sign at least node + egress-fetch, signed ${machos.length}`);
  }
}

main().catch((e) => {
  console.error(`[sidecar] FAILED: ${e?.stack || e}`);
  process.exit(1);
});

/**
 * Remove native prebuilds that cannot run on THIS build machine (foreign libc
 * or CPU): package dirs and loose *.node files whose names declare musl or a
 * different arch/platform. Only runs for the linux-x64 glibc host — the one
 * place linuxdeploy walks the tree; cross-platform release builds assemble on
 * their own hosts.
 */
async function pruneForeignNative(nodeModules) {
  if (process.platform !== "linux" || process.arch !== "x64") return;
  const FOREIGN = /musl|linux-arm64|aarch64|darwin|win32|windows/i;
  let pruned = 0;
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        // A variant PACKAGE dir (…/keyring-linux-x64-musl, @img/sharp-linuxmusl-x64).
        if (FOREIGN.test(e.name) && /(^|[/\\])node_modules[/\\]/.test(full + "/")) {
          await rm(full, { recursive: true, force: true });
          pruned++;
          continue;
        }
        await walk(full);
      } else if (e.name.endsWith(".node") && FOREIGN.test(e.name)) {
        // A loose foreign prebuild inside an otherwise-native package
        // (snowflake-sdk ships every arch under dist/lib/minicore/binaries).
        await rm(full, { force: true });
        pruned++;
      }
    }
  }
  await walk(nodeModules);
  log(`pruned ${pruned} foreign-native artifact(s) (musl/other-arch)`);
}
