#!/usr/bin/env node
/**
 * .mcpb bundle smoke test (release-path phase 2; pattern: mcp-proof.mjs).
 *
 * Proves the PACKED server actually serves MCP: spawns `node
 * dist/mcpb/server.js` exactly as Claude Desktop would — from a foreign
 * working directory, with no checkout on the module path — and completes an
 * initialize handshake + tools/list over stdio, then connects a real CSV to
 * prove the pipeline (parsing, stores, path roots) boots inside the bundle.
 * Zero API keys, zero network, zero LLM calls.
 *
 *   pnpm mcpb:build && pnpm mcpb:smoke
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EGRESS_BIN_PLATFORMS, bundledEgressBinRelPath } from "@/lib/release/egress-bin-layout";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const BUNDLE = join(ROOT, "dist", "mcpb");

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

// 1. Bundle shape — every runtime asset the server reads must be inside.
if (!existsSync(join(BUNDLE, "server.js")))
  fail("dist/mcpb/server.js missing — run `pnpm mcpb:build`");
for (const f of [
  "manifest.json",
  "viewer-dist/viewer.html",
  "viewer-dist/export-manifest.json",
  "docker/sandbox/hermetic_runtime/frames.py",
  "docker/sandbox/prelude.py",
  "docker/sandbox/egress-proxy.py",
  "node_modules/@napi-rs/keyring/package.json",
]) {
  if (!existsSync(join(BUNDLE, f))) fail(`bundle asset missing: ${f}`);
}
const manifest = JSON.parse(readFileSync(join(BUNDLE, "manifest.json"), "utf-8"));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
if (manifest.name !== "hermetic") fail(`manifest name is ${manifest.name}`);
if (manifest.version !== pkg.version)
  fail(`manifest version ${manifest.version} != ${pkg.version}`);
if (manifest.server.entry_point !== "server.js") fail("manifest entry_point drifted");
console.error(`✔ bundle shape ok (manifest ${manifest.name}@${manifest.version})`);

// 1b. The vendored DuckDB node engine actually BOOTS from the bundle with the
// pruned (eh-only) dist — the exact assets host-duckdb resolves at runtime.
for (const f of [
  "node_modules/@duckdb/duckdb-wasm/package.json",
  "node_modules/@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs",
  "node_modules/@duckdb/duckdb-wasm/dist/duckdb-node-eh.worker.cjs",
  "node_modules/@duckdb/duckdb-wasm/dist/duckdb-eh.wasm",
]) {
  if (!existsSync(join(BUNDLE, f))) fail(`bundle asset missing: ${f}`);
}
{
  const req = createRequire(join(BUNDLE, "server.js"));
  const duckdb = req("@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs");
  const dist = join(BUNDLE, "node_modules", "@duckdb", "duckdb-wasm", "dist");
  const db = await duckdb.createDuckDB(
    {
      eh: {
        mainModule: join(dist, "duckdb-eh.wasm"),
        mainWorker: join(dist, "duckdb-node-eh.worker.cjs"),
      },
    },
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME
  );
  await db.instantiate();
  const rows = db
    .connect()
    .query("SELECT 42 AS x")
    .toArray()
    .map((r) => r.toJSON());
  if (rows[0]?.x !== 42) fail(`vendored duckdb answered wrong: ${JSON.stringify(rows)}`);
  console.error("✔ vendored duckdb-wasm node engine boots (eh-only) and answers");
}

// 1c. Egress-fetch bins: whatever platforms the bundle claims must be REAL
// files, and the host platform's bin must actually spawn (a no-arg run exits
// nonzero with usage — ENOENT/EACCES here means a broken vendor).
{
  const vendored = EGRESS_BIN_PLATFORMS.filter((id) =>
    existsSync(join(BUNDLE, ...bundledEgressBinRelPath(...id.split("-")).split("/")))
  );
  const requireAll = process.env.HERMETIC_MCPB_REQUIRE_ALL_BINS === "1";
  if (requireAll && vendored.length !== EGRESS_BIN_PLATFORMS.length) {
    fail(
      `egress-fetch bins incomplete: have [${vendored.join(", ")}], ` +
        `want [${EGRESS_BIN_PLATFORMS.join(", ")}]`
    );
  }
  const hostRel = bundledEgressBinRelPath(process.platform, process.arch);
  const hostBin = hostRel ? join(BUNDLE, ...hostRel.split("/")) : null;
  if (hostBin && existsSync(hostBin)) {
    const run = spawnSync(hostBin, [], { timeout: 10_000 });
    if (run.error) fail(`host egress-fetch bin does not spawn: ${run.error.message}`);
    if (run.status === 0) fail("egress-fetch with no args exited 0 — wrong binary?");
    console.error(`✔ egress-fetch bins: ${vendored.join(", ")} (host bin spawns)`);
  } else if (requireAll) {
    fail("host platform egress-fetch bin missing under REQUIRE_ALL");
  } else {
    console.error(`! egress-fetch host bin not vendored (dev bundle) — spawn check skipped`);
  }
}

// 2. Handshake — spawn from a NEUTRAL cwd so any lingering cwd-anchored path
// would break here instead of on a user's machine.
const scratch = mkdtempSync(join(tmpdir(), "mcpb-smoke-"));
const dataRoot = join(scratch, "data");
const csvPath = join(scratch, "smoke.csv");
writeFileSync(csvPath, "month,revenue\n2026-01,100\n2026-02,140\n2026-03,180\n");

const watchdog = setTimeout(() => fail("smoke test timed out after 90s"), 90_000);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(BUNDLE, "server.js")],
  cwd: scratch,
  env: {
    ...process.env,
    HERMETIC_DATA_ROOT: dataRoot, // keep the run hermetic — no ~/.hermetic writes
    HERMETIC_LOCAL_FILE_ROOTS: scratch, // permit the scratch csv past the connect_source path-jail (#128)
    HERMETIC_MCP_VIEWER_PORT: "0", // ephemeral port — never collide with a dev server
  },
  stderr: "inherit",
});
const client = new Client({ name: "mcpb-smoke", version: "0.0.0" });
await client.connect(transport);
console.error("✔ initialize handshake completed over stdio");

// 3. Tool surface.
const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
for (const required of ["connect_source", "analyze"]) {
  if (!names.includes(required)) fail(`tool missing from bundle: ${required}`);
}
console.error(`✔ tools/list: ${names.join(", ")}`);

// 4. The pipeline boots inside the bundle: connect a real CSV (no LLM).
const connectRes = await client.callTool({ name: "connect_source", arguments: { path: csvPath } });
const connected = JSON.parse(connectRes.content[0].text);
if (!connected.source_id) fail(`connect_source failed: ${connectRes.content[0].text}`);
if (connected.schema.row_count !== 3) fail(`expected 3 rows, got ${connected.schema.row_count}`);
console.error(
  `✔ connect_source: ${connected.source_id} (${connected.schema.row_count} rows, ` +
    `${connected.schema.column_count} columns)`
);

await client.close();
clearTimeout(watchdog);
rmSync(scratch, { recursive: true, force: true });
console.error("mcpb smoke ok.");
process.exit(0);
