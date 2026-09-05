#!/usr/bin/env node
/**
 * Build the Claude Desktop extension bundle (release-path phase 2;
 * distribution channel #1 — .mcpb first).
 *
 * Assembles dist/mcpb/ then packs it into hermetic.mcpb (a zip with a
 * manifest, per the MCP bundle format — @anthropic-ai/mcpb):
 *
 *   server.js      — esbuild CJS bundle of src/mcp/mcpb-main.ts (the entry
 *                    that pins path roots for the installed layout)
 *   viewer-dist/   — the embedded viewer + export bundles (build-mcp-viewer
 *                    output; `pnpm mcpb:build` chains that build first)
 *   docker/sandbox/— hermetic_runtime + prelude.py + egress-proxy.py, the
 *                    Python assets lib/paths reads from assetRoot at runtime
 *   node_modules/  — the ONE runtime dep that cannot live inside the bundle:
 *                    @napi-rs/keyring (native addon), vendored with bindings
 *                    for every mainstream platform so one .mcpb installs on
 *                    macOS/Windows/Linux alike
 *   manifest.json  — name hermetic, version from package.json, node stdio
 *
 * Deliberately NOT bundled (stubbed, not silently broken): snowflake-sdk,
 * @databricks/sql, hive-driver — warehouse drivers with native bindings
 * esbuild cannot bundle and whose vendored node_modules would dwarf the
 * bundle. Importing a stub is free (connector.ts imports all drivers at
 * module load); USING one throws a clear "needs the full checkout" error.
 * CSV/Excel/Parquet analysis — the extension's job — is unaffected.
 */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
// Shared layout (runs under tsx — see package.json mcpb:build): the SAME
// module mcpb-main.ts resolves the bin from at boot, so writer and reader
// cannot drift.
import {
  EGRESS_BIN_PLATFORMS,
  egressBinFilename,
  egressBinPlatform,
} from "@/lib/release/egress-bin-layout";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "dist", "mcpb");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ── 1. Server bundle ──────────────────────────────────────────────────
// Warehouse drivers with unbundleable native bindings become lazy stubs:
// importing costs nothing, any actual use throws with a pointer to the full
// checkout. Everything else — pg, BigQuery, ClickHouse, Trino, the whole
// pipeline — bundles for real.
// Each stub is an ESM module exporting exactly the bindings the connector
// files import (grep `from "<pkg>"` under src/lib/warehouse when these ever
// drift — an unknown binding fails the esbuild step loudly, not at runtime).
const STUBBED_DRIVERS = {
  "snowflake-sdk": [],
  "@databricks/sql": ["DBSQLClient"],
  "hive-driver": ["HiveClient", "thrift", "auth", "connections"],
};

const stubSource = (
  pkgName
) => `// Injected by scripts/build-mcpb.mjs — see the header there for why.
const MSG = ${JSON.stringify(
  `The ${pkgName} warehouse driver is not included in the hermetic Desktop extension ` +
    `(its native bindings cannot ship in a portable bundle). Local files (CSV/Excel/Parquet) ` +
    `and the bundled warehouse engines work here; for this engine, run hermetic from a full ` +
    `checkout: https://github.com/achalp/hermetic`
)};
function bomb() { throw new Error(MSG); }
// Property reads chain freely (module-level destructuring stays lazy);
// calling or constructing ANYTHING throws the pointer above.
function stub() {
  return new Proxy(function () {}, {
    get(_t, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return stub();
    },
    apply: bomb,
    construct: bomb,
  });
}
export default stub();
${STUBBED_DRIVERS[pkgName].map((name) => `export const ${name} = stub();`).join("\n")}
`;

/** esbuild plugin: replace each stubbed package with a throwing lazy proxy. */
const stubDriversPlugin = {
  name: "stub-native-drivers",
  setup(b) {
    const filter = new RegExp(
      `^(${Object.keys(STUBBED_DRIVERS)
        .map((p) => p.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
        .join("|")})$`
    );
    b.onResolve({ filter }, (args) => ({ path: args.path, namespace: "hermetic-driver-stub" }));
    b.onLoad({ filter: /.*/, namespace: "hermetic-driver-stub" }, (args) => ({
      contents: stubSource(args.path),
      loader: "js",
    }));
  },
};

const result = await build({
  entryPoints: [join(ROOT, "src/mcp/mcpb-main.ts")],
  outfile: join(OUT, "server.js"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: false,
  minify: false, // stack traces from installed bundles must stay readable
  metafile: true,
  logLevel: "warning",
  alias: { "@": join(ROOT, "src") },
  // The keychain addon stays a real module, vendored below.
  external: ["@napi-rs/keyring"],
  plugins: [stubDriversPlugin],
});
const serverBytes = statSync(join(OUT, "server.js")).size;
console.error(
  `server.js: ${(serverBytes / 1024 / 1024).toFixed(1)}MB from ` +
    `${Object.keys(result.metafile.inputs).length} inputs`
);

// ── 2. Vendor the keychain addon (all mainstream platforms) ──────────
// @napi-rs/keyring loads its platform binding via require(), so it must
// exist as a real package next to server.js. The local install carries only
// the host platform's binding; the other platforms' packages are fetched
// from npm so ONE .mcpb installs everywhere. secrets.ts degrades gracefully
// (env-var fallback) if a binding is ever missing at runtime.
const KEYRING_PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "win32-x64-msvc",
  "win32-arm64-msvc",
  "linux-x64-gnu",
  "linux-arm64-gnu",
  "linux-x64-musl",
];

const keyringDir = dirname(require.resolve("@napi-rs/keyring/package.json"));
const keyringVersion = JSON.parse(readFileSync(join(keyringDir, "package.json"), "utf-8")).version;
const vendorRoot = join(OUT, "node_modules", "@napi-rs");
mkdirSync(vendorRoot, { recursive: true });
cpSync(keyringDir, join(vendorRoot, "keyring"), { recursive: true, dereference: true });

const scratch = mkdtempSync(join(tmpdir(), "mcpb-keyring-"));
const vendored = [];
const missing = [];
for (const platform of KEYRING_PLATFORMS) {
  const name = `@napi-rs/keyring-${platform}`;
  const dest = join(vendorRoot, `keyring-${platform}`);
  try {
    // Local install first (pnpm keeps the host platform's binding on disk).
    const local = dirname(require.resolve(`${name}/package.json`));
    cpSync(local, dest, { recursive: true, dereference: true });
    vendored.push(platform);
    continue;
  } catch {
    // Not installed locally — fetch the exact published version from npm.
  }
  try {
    execFileSync("npm", ["pack", `${name}@${keyringVersion}`, "--pack-destination", scratch], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    const tgz = readdirSync(scratch).find((f) => f.includes(`keyring-${platform}`));
    if (!tgz) throw new Error("npm pack produced no tarball");
    const unpackDir = join(scratch, `unpack-${platform}`);
    mkdirSync(unpackDir, { recursive: true });
    execFileSync("tar", ["-xzf", join(scratch, tgz), "-C", unpackDir], { stdio: "inherit" });
    // cp not rename: the scratch dir may live on another filesystem (EXDEV).
    cpSync(join(unpackDir, "package"), dest, { recursive: true });
    vendored.push(platform);
  } catch (err) {
    missing.push(platform);
    console.error(`! keyring binding ${platform} not vendored: ${err.message ?? err}`);
  }
}
rmSync(scratch, { recursive: true, force: true });
console.error(`keyring ${keyringVersion} vendored: ${vendored.join(", ")}`);
if (missing.length > 0 && process.env.HERMETIC_MCPB_KEYRING_HOST_ONLY !== "1") {
  fail(
    `keyring bindings missing for: ${missing.join(", ")} — the bundle would not install ` +
      `keychain support there. Re-run with network access, or set ` +
      `HERMETIC_MCPB_KEYRING_HOST_ONLY=1 to accept a host-platform-only bundle.`
  );
}

// ── 2b. Vendor the DuckDB-WASM node engine (eh bundle only) ──────────
// host-duckdb.ts (the in-process engine behind local-parquet connect on the
// built-in runtime) resolves `@duckdb/duckdb-wasm/dist/*` from assetRoot.
// Only the eh bundle ships: the mvp module is 41 MB of fallback for
// pre-wasm-exception-handling engines no supported Node needs, and
// availableDuckDbBundles() filters by what exists. Always vendored (source is
// the checkout's own node_modules), so every .mcpb can connect local parquet
// without Docker.
// Located on disk, not require.resolve()'d: the package's exports map does
// not expose ./package.json (same situation as @anthropic-ai/mcpb below).
const duckdbPkgDir = join(ROOT, "node_modules", "@duckdb", "duckdb-wasm");
const duckdbDest = join(OUT, "node_modules", "@duckdb", "duckdb-wasm");
mkdirSync(join(duckdbDest, "dist"), { recursive: true });
cpSync(join(duckdbPkgDir, "package.json"), join(duckdbDest, "package.json"));
for (const f of ["duckdb-node-blocking.cjs", "duckdb-node-eh.worker.cjs", "duckdb-eh.wasm"]) {
  cpSync(join(duckdbPkgDir, "dist", f), join(duckdbDest, "dist", f), { dereference: true });
}
console.error("duckdb-wasm node engine vendored (eh bundle)");

// ── 2c. Vendor the egress-fetch binaries (per platform) ──────────────
// The Rust host-side remote-read edge (manifest fetch, S3 listing, ranged
// reads). CI's egress-bins job stages one native build per platform under
// dist/egress-bins/<platform-arch>/; a local dev build falls back to the
// checkout's own cargo output for the HOST platform only (that bundle then
// works on this machine alone — loudly noted). Release builds set
// HERMETIC_MCPB_REQUIRE_ALL_BINS=1 so a missing platform fails the build
// instead of shipping a bundle that quietly lacks manifests there.
const BIN_SRC = process.env.HERMETIC_EGRESS_BINS_DIR ?? join(ROOT, "dist", "egress-bins");
const binsVendored = [];
const binsMissing = [];
for (const id of EGRESS_BIN_PLATFORMS) {
  const name = egressBinFilename(id);
  const src = join(BIN_SRC, id, name);
  let from = existsSync(src) ? src : null;
  if (!from && id === egressBinPlatform(process.platform, process.arch)) {
    for (const profile of ["release", "debug"]) {
      const local = join(ROOT, "rust", "egress-core", "target", profile, name);
      if (existsSync(local)) {
        from = local;
        console.error(`! egress-fetch ${id}: using local cargo ${profile} build (dev fallback)`);
        break;
      }
    }
  }
  if (!from) {
    binsMissing.push(id);
    continue;
  }
  const dest = join(OUT, "bin", id, name);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(from, dest, { dereference: true });
  if (!id.startsWith("win32")) chmodSync(dest, 0o755);
  binsVendored.push(id);
}
console.error(`egress-fetch vendored: ${binsVendored.join(", ") || "(none)"}`);
if (binsMissing.length > 0) {
  const msg =
    `egress-fetch bins missing for: ${binsMissing.join(", ")} — those installs get no ` +
    `manifest support and no wasm-runtime remote reads.`;
  if (process.env.HERMETIC_MCPB_REQUIRE_ALL_BINS === "1") fail(msg);
  console.error(`! ${msg} (dev bundle — release builds require all)`);
}

// ── 3. Viewer + sandbox runtime assets ───────────────────────────────
const viewerDist = join(ROOT, "src", "mcp", "viewer", "dist");
if (!existsSync(join(viewerDist, "viewer.html"))) {
  fail("viewer bundle missing — run `pnpm mcp:build-viewer` first (pnpm mcpb:build chains it)");
}
cpSync(viewerDist, join(OUT, "viewer-dist"), { recursive: true });

const pycache = (src) => !/__pycache__|\.pyc$/.test(src);
cpSync(
  join(ROOT, "docker", "sandbox", "hermetic_runtime"),
  join(OUT, "docker", "sandbox", "hermetic_runtime"),
  { recursive: true, filter: pycache }
);
for (const f of ["prelude.py", "egress-proxy.py"]) {
  cpSync(join(ROOT, "docker", "sandbox", f), join(OUT, "docker", "sandbox", f));
}

// License texts travel with the redistributed bundle. Apache-2.0 §4(d) requires
// the vendored json-render NOTICE to accompany derivative distributions, and the
// bundled OFL fonts require their license alongside the font files.
mkdirSync(join(OUT, "licenses"), { recursive: true });
cpSync(join(ROOT, "LICENSE"), join(OUT, "LICENSE"));
cpSync(join(ROOT, "THIRD-PARTY-NOTICES.md"), join(OUT, "THIRD-PARTY-NOTICES.md"));
cpSync(join(ROOT, "src", "spec", "LICENSE"), join(OUT, "licenses", "json-render-LICENSE"));
cpSync(join(ROOT, "src", "spec", "NOTICE.md"), join(OUT, "licenses", "json-render-NOTICE.md"));

// ── 4. Manifest ──────────────────────────────────────────────────────
const manifest = {
  manifest_version: "0.3",
  name: "hermetic",
  display_name: "Hermetic",
  version: pkg.version,
  description: pkg.description,
  long_description:
    "Local-first data analysis for Claude: connect CSV/Excel/Parquet files (and supported " +
    "warehouses), ask questions in natural language, and get verified interactive dashboards. " +
    "Your data never leaves your machine — only schemas and computed aggregates reach the model.",
  author: { name: pkg.author },
  repository: pkg.repository,
  license: pkg.license,
  keywords: pkg.keywords,
  server: {
    type: "node",
    entry_point: "server.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/server.js"],
      env: {},
    },
  },
  compatibility: {
    platforms: ["darwin", "win32", "linux"],
    runtimes: { node: pkg.engines.node },
  },
};
writeFileSync(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// ── 5. Pack ──────────────────────────────────────────────────────────
// The official packer validates the manifest and zips the directory. Its
// package.json is not on the exports map, so locate it on disk (the
// node_modules symlink resolves through readFileSync just fine).
const mcpbPkgPath = join(ROOT, "node_modules", "@anthropic-ai", "mcpb", "package.json");
const mcpbPkg = JSON.parse(readFileSync(mcpbPkgPath, "utf-8"));
const binRel = typeof mcpbPkg.bin === "string" ? mcpbPkg.bin : mcpbPkg.bin.mcpb;
const mcpbBin = join(dirname(mcpbPkgPath), binRel);
const outFile = join(ROOT, "hermetic.mcpb");
execFileSync(process.execPath, [mcpbBin, "pack", OUT, outFile], { stdio: "inherit" });
console.error(`hermetic.mcpb: ${(statSync(outFile).size / 1024 / 1024).toFixed(1)}MB`);
