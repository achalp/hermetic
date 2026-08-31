#!/usr/bin/env node
/**
 * Assemble the same-origin DuckDB-WASM asset tree served at /duckdb/* (build log D18).
 *
 * Three things land in `public/duckdb-wasm/`:
 *
 *  1. `duckdb-bundle.js` — the BLOCKING browser build, bundled by esbuild into a
 *     classic-worker IIFE (global `DuckDBB`). It must be classic, not ESM: the
 *     execution worker is a classic worker (importScripts) so `script-src 'self'`
 *     covers it, and the shipped `.mjs` imports a bare `apache-arrow` specifier a
 *     browser cannot resolve (the D18 spike hit exactly that).
 *
 *  2. `duckdb-mvp.wasm` — the module the blocking glue is built against. Pairing it
 *     with `duckdb-eh.wasm` traps at runtime with `call_indirect to a signature that
 *     does not match` (also measured in D18), so we deliberately ship mvp only.
 *
 *  3. `ext/<version>/wasm_mvp/*.duckdb_extension.wasm` — a LOCAL extension repository.
 *     DuckDB autoloads `parquet` (and `httpfs` for ranged remote reads) from
 *     extensions.duckdb.org, which the worker's `connect-src 'self'` correctly blocks.
 *     Vendoring them here is what lets DuckDB work under the sandbox CSP unchanged.
 *
 * Extensions are downloaded once and CACHED in the output dir; pass --offline to fail
 * rather than reach the network (CI/packaging determinism).
 */
import { createRequire } from "node:module";
import { mkdir, writeFile, stat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "duckdb-wasm");
// The package's `exports` map exposes neither dist/* nor package.json by name, so
// address the install directly (the D18 spike hit the same wall).
const PKG = join(ROOT, "node_modules", "@duckdb", "duckdb-wasm");
const DIST = join(PKG, "dist");

/** Extensions the analysis tier needs: parquet (always) + httpfs (ranged remote reads). */
const EXTENSIONS = ["parquet", "httpfs"];
const OFFLINE = process.argv.includes("--offline");

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The DuckDB release version, which decides the extension repository path DuckDB
 * asks for at runtime. ASK DUCKDB rather than guessing: the npm version (e.g.
 * 1.33.1) is the JS wrapper's, not the engine's, and the wasm binary contains
 * several version-shaped strings. Booting the node build and reading `version()`
 * is authoritative and stays correct across upgrades.
 */
async function duckdbVersion() {
  const require = createRequire(join(ROOT, "package.json"));
  const duckdb = require(join(DIST, "duckdb-node-blocking.cjs"));
  const db = await duckdb.createDuckDB(
    {
      mvp: {
        mainModule: join(DIST, "duckdb-mvp.wasm"),
        mainWorker: join(DIST, "duckdb-node-mvp.worker.cjs"),
      },
      eh: {
        mainModule: join(DIST, "duckdb-eh.wasm"),
        mainWorker: join(DIST, "duckdb-node-eh.worker.cjs"),
      },
    },
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME
  );
  await db.instantiate();
  const raw = JSON.parse(db.connect().query("SELECT version() AS v").toString())[0].v;
  const m = /^v?(\d+\.\d+\.\d+)/.exec(String(raw));
  if (!m) throw new Error(`cannot parse DuckDB version from ${raw}`);
  return m[1];
}

/**
 * `duckdb-browser-blocking.mjs` calls `_setThrew(…)` in 345 places — every one of
 * them inside an Emscripten `invoke_*` catch block, i.e. the C++ exception path —
 * and DEFINES IT NOWHERE. Verified against the upstream file, not just our bundle:
 * 345 references, 0 declarations, in both. This is not a bundling artifact.
 *
 * Why it stayed hidden: `invoke_*` is only entered when a C++ exception actually
 * propagates, so every happy path works (the D18 spike ran a full query). The first
 * real DuckDB error turns into `ReferenceError: Can't find variable: _setThrew`,
 * which names nothing useful and buries the actual failure — that is exactly how it
 * showed up on the first live Overture connect (D31).
 *
 * Why we do NOT reimplement it: the historical JS version stored `__THREW__` state
 * that the WASM side reads back. A JS-only stub would let the module continue
 * believing nothing was thrown — trading a loud crash for silent corruption. The
 * blocking build is MVP glue (it ships `invoke_*`), so the eh module is not an
 * option either: that pairing is the `call_indirect signature mismatch` from D18.
 *
 * So this shim does the one honest thing available — it makes the failure LEGIBLE.
 * The process still stops, but with a message that names the upstream defect and
 * says what actually happened: DuckDB raised an error and could not report it.
 */
const SETTHREW_SHIM = `/* hermetic: see build-duckdb-wasm-assets.mjs (D31) */
var _setThrew = function (threw, value) {
  throw new Error(
    "DuckDB-WASM raised an internal error and could not report it: the blocking " +
      "browser build calls _setThrew() without defining it (upstream defect). " +
      "The ORIGINAL failure is whatever DuckDB was doing when this fired — a failed " +
      "range read is the usual cause. threw=" + threw + " value=" + value
  );
};
`;

/**
 * Fail the asset build if the shim ever stops being needed OR stops being applied.
 * Both directions matter: an upstream fix should retire this file's shim rather than
 * shadow a real `_setThrew`, and a silently-dropped banner would restore the
 * unreadable crash.
 */
async function assertSetThrewDefined(bundlePath) {
  const text = await readFile(bundlePath, "utf8");
  const calls = text.match(/_setThrew\s*\(/g)?.length ?? 0;
  const declared = /var _setThrew = function/.test(text);
  if (calls > 0 && !declared) {
    throw new Error("duckdb bundle calls _setThrew but the shim was not applied");
  }
  console.log(`duckdb-wasm: _setThrew shim applied (${calls} call sites guarded)`);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  // 1. the classic-worker bundle
  const entry = join(OUT, ".entry.mjs");
  await writeFile(
    entry,
    `export * from ${JSON.stringify(join(DIST, "duckdb-browser-blocking.mjs"))};\n`
  );
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    globalName: "DuckDBB",
    platform: "browser",
    outfile: join(OUT, "duckdb-bundle.js"),
    logLevel: "warning",
    // See SETTHREW_SHIM. Goes in a BANNER (outside the IIFE) on purpose: the
    // undefined reference lives inside esbuild's IIFE, and an inner scope falls
    // through to the global one — so a global declaration is what resolves it.
    banner: { js: SETTHREW_SHIM },
  });
  await assertSetThrewDefined(join(OUT, "duckdb-bundle.js"));
  const bundleBytes = (await stat(join(OUT, "duckdb-bundle.js"))).size;
  console.log(`duckdb-wasm: bundle ${(bundleBytes / 1e6).toFixed(1)}MB`);

  // 2. the mvp wasm module (see header: eh traps against the blocking glue)
  const wasm = await readFile(join(DIST, "duckdb-mvp.wasm"));
  await writeFile(join(OUT, "duckdb-mvp.wasm"), wasm);
  console.log(`duckdb-wasm: duckdb-mvp.wasm ${(wasm.length / 1e6).toFixed(1)}MB`);

  // 3. the local extension repository
  const version = await duckdbVersion();
  const extDir = join(OUT, "ext", `v${version}`, "wasm_mvp");
  await mkdir(extDir, { recursive: true });
  for (const name of EXTENSIONS) {
    const dest = join(extDir, `${name}.duckdb_extension.wasm`);
    if (await exists(dest)) {
      console.log(`duckdb-wasm: ${name} extension cached`);
      continue;
    }
    if (OFFLINE) throw new Error(`--offline but ${name} extension is not vendored at ${dest}`);
    const url = `https://extensions.duckdb.org/v${version}/wasm_mvp/${name}.duckdb_extension.wasm`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    // Extensions are WASM modules; refuse anything that isn't (a captive-portal
    // HTML error page must never be written into the repository as an extension).
    if (buf.subarray(0, 4).toString("latin1") !== "\0asm") {
      throw new Error(`${url} did not return a WASM module`);
    }
    await writeFile(dest, buf);
    console.log(`duckdb-wasm: ${name} extension ${(buf.length / 1e6).toFixed(1)}MB downloaded`);
  }

  console.log(`duckdb-wasm: assets ready in public/duckdb-wasm (DuckDB v${version})`);
}

main().catch((err) => {
  console.error("build-duckdb-wasm-assets failed:", err.message);
  process.exit(1);
});
