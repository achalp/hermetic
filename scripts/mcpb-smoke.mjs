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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
