#!/usr/bin/env node
/**
 * MCP harness proof (mcp-server spec §4 M1/M2; wired into CI by M5).
 *
 * Drives the REAL server over stdio with the SDK client: connect the fixture
 * CSV, read its schema, run the flagship analyze offline (LLM from committed
 * replay fixtures; sandbox executes for real), and assert the boundary
 * invariants hold on the wire. Zero API keys, zero network.
 *
 *   HERMETIC_LLM_MODE=replay node scripts/mcp-proof.mjs
 *
 * The question/filename MUST match the recorded fixtures (same contract as
 * the CLI proof): "What is the MRR trend over time?" over fixture.csv.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { copyFileSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(new URL("..", import.meta.url).pathname);

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

const scratch = mkdtempSync(join(tmpdir(), "mcp-proof-"));
const csvPath = join(scratch, "fixture.csv");
copyFileSync(join(ROOT, "test-specs/data/01-saas-mrr.csv"), csvPath);

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "src/mcp/main.ts"],
  cwd: ROOT,
  env: {
    ...process.env,
    HERMETIC_LLM_MODE: "replay",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "test-key-replay-only",
    HERMETIC_DATA_DIR_UNUSED: scratch, // documentation: data root is cwd/data (no env override yet)
  },
  stderr: "inherit",
});
const client = new Client({ name: "mcp-proof", version: "0.0.0" });
await client.connect(transport);

const parse = (r) => JSON.parse(r.content[0].text);

// 1. Tool surface
const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
for (const required of ["connect_source", "get_schema", "run_sql", "analyze"]) {
  if (!names.includes(required)) fail(`tool missing: ${required}`);
}
console.error(`✔ tools: ${names.join(", ")}`);

// 2. Connect + boundary invariant
const connected = parse(
  await client.callTool({ name: "connect_source", arguments: { path: csvPath } })
);
if (!connected.source_id) fail("connect_source returned no source_id");
if (JSON.stringify(connected).includes("sample_rows")) fail("raw rows leaked in connect_source");
console.error(`✔ connect_source: ${connected.source_id} (${connected.schema.row_count} rows)`);

// 3. Schema
const schema = parse(
  await client.callTool({ name: "get_schema", arguments: { source_id: connected.source_id } })
);
if (schema.schema.column_count < 2) fail("schema too thin");
console.error(`✔ get_schema: ${schema.schema.column_count} columns`);

// 4. analyze — full pipeline offline
const analysis = parse(
  await client.callTool({
    name: "analyze",
    arguments: { source_id: connected.source_id, question: "What is the MRR trend over time?" },
  })
);
if (analysis.error) fail(`analyze failed: ${analysis.error}`);
if (!analysis.history_id) fail("analyze did not persist a history entry");
if (!analysis.element_count || analysis.element_count < 3) {
  fail(`suspiciously small dashboard: ${analysis.element_count} elements`);
}
if (!analysis.summary || analysis.summary.length < 40) fail("summary missing/too short");
console.error(
  `✔ analyze: ${analysis.element_count} elements, history ${analysis.history_id}, url ${analysis.dashboard_url}`
);

// 5. The persisted entry is real on disk
const entryDir = join(ROOT, "data", "history", analysis.history_id);
if (!existsSync(join(entryDir, "spec.json"))) fail("history entry missing on disk");
const spec = JSON.parse(readFileSync(join(entryDir, "spec.json"), "utf-8"));
if (!spec.root || spec.hermeticSpecVersion !== 1) fail("persisted spec malformed");
console.error(`✔ history entry on disk with hermeticSpecVersion=1`);

// 5b. The dashboard link is served by the EMBEDDED viewer (M3): fetch the
// page and the spec through the link the host would click.
const viewerUrl = new URL(analysis.dashboard_url);
if (viewerUrl.port === "3000") fail("dashboard_url still points at the web app, not the viewer");
const page = await fetch(`${viewerUrl.origin}/`);
if (!page.ok) fail(`viewer page not served: ${page.status}`);
const pageText = await page.text();
if (!pageText.includes("viewer.js")) fail("viewer shell missing bundle reference");
const specRes = await fetch(`${viewerUrl.origin}/api/spec/${analysis.history_id}`);
if (!specRes.ok) fail(`viewer /api/spec failed: ${specRes.status}`);
const served = await specRes.json();
if (served.spec.root !== spec.root) fail("viewer served a different spec than persisted");
console.error(`✔ embedded viewer serves the dashboard at ${viewerUrl.origin}`);

// 6. Audit trail exists and mentions the calls
const auditFile = join(ROOT, "data", "mcp-audit.jsonl");
if (!existsSync(auditFile)) fail("audit log missing");
const auditLines = readFileSync(auditFile, "utf-8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
const audited = auditLines.slice(-4).map((e) => e.tool);
if (!audited.includes("analyze")) fail("analyze not audited");
console.error(`✔ audit log: ${auditLines.length} entries`);

await client.close();
console.error("MCP proof ok.");
process.exit(0);
