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
    HERMETIC_LOCAL_FILE_ROOTS: scratch, // permit the scratch csv past the connect_source path-jail (#128)
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

// 4. analyze — full pipeline offline, with progress. A real run takes
// minutes; the host must not be blind, so the proof asserts updates arrive.
const progressSeen = [];
const analysis = parse(
  await client.callTool(
    {
      name: "analyze",
      arguments: { source_id: connected.source_id, question: "What is the MRR trend over time?" },
    },
    undefined,
    { onprogress: (p) => progressSeen.push(p.message ?? "") }
  )
);
if (analysis.error) fail(`analyze failed: ${analysis.error}`);
if (!analysis.history_id) fail("analyze did not persist a history entry");
if (!analysis.element_count || analysis.element_count < 3) {
  fail(`suspiciously small dashboard: ${analysis.element_count} elements`);
}
if (!analysis.summary || analysis.summary.length < 40) fail("summary missing/too short");
// The summary must be FINDINGS, not chart labels: every element's `title`
// prop is a label, and none of them may appear as summary prose.
if (!Array.isArray(analysis.headline_stats) || analysis.headline_stats.length === 0) {
  fail("analyze returned no headline_stats — the host gets prose but no figures");
}
if (progressSeen.length < 2) {
  fail(`analyze emitted ${progressSeen.length} progress updates — the host would be blind`);
}
console.error(
  `✔ progress: ${progressSeen.length} updates (${progressSeen.slice(0, 3).join(", ")}…)`
);
console.error(
  `✔ analyze: ${analysis.element_count} elements, history ${analysis.history_id}, url ${analysis.dashboard_url}`
);

// 4b. analyze returns the COMPUTED VALUES, so a follow-up number needs no
// recomputation and verify_narrative has something to check (the flow-
// coherence fix — without this the host must redundantly re-run the work).
if (!analysis.results || typeof analysis.results !== "object") {
  fail("analyze returned no `results` — host would have to recompute");
}
if (!analysis.chart_data || Object.keys(analysis.chart_data).length === 0) {
  fail("analyze returned no `chart_data`");
}
if (JSON.stringify(analysis).includes('"datasets"')) fail("row-level datasets leaked from analyze");
console.error(
  `✔ analyze artifacts: ${Object.keys(analysis.results).length} results, ` +
    `${Object.keys(analysis.chart_data).length} chart series (datasets withheld)`
);

// 4c. verify_narrative anchored SERVER-SIDE: a fabricated figure must be
// caught even though the host supplies no values of its own — this is the
// trust pillar, so a vacuous "0 numbers checked" pass is not acceptable.
const fabricated = parse(
  await client.callTool({
    name: "verify_narrative",
    arguments: {
      source_id: connected.source_id,
      prose: "Revenue reached $9,847,321 this quarter, up 412.7% year over year.",
    },
  })
);
if (fabricated.error) fail(`verify_narrative (server anchor) failed: ${fabricated.error}`);
if (fabricated.anchor !== "server") fail(`expected server anchor, got ${fabricated.anchor}`);
if (fabricated.checked_count < 2) {
  fail(`grounding checked ${fabricated.checked_count} numbers — it is not actually reading prose`);
}
if (fabricated.ok || fabricated.ungrounded.length === 0) {
  fail("fabricated figures were NOT flagged — verify_narrative is vacuous");
}
console.error(
  `✔ verify_narrative (server-anchored): flagged ${fabricated.ungrounded.length} fabricated ` +
    `of ${fabricated.checked_count} checked, against ${fabricated.grounded_value_count} real values`
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

// 5c. Single-file export (dashboard-distribution spec): the viewer's
// /api/export/<id> must return a self-contained download whose inline spec
// matches the persisted one, and analyze must advertise it as export_url.
if (!analysis.export_url) fail("analyze response missing export_url");
const exportRes = await fetch(analysis.export_url);
if (!exportRes.ok) fail(`viewer /api/export failed: ${exportRes.status}`);
const disposition = exportRes.headers.get("content-disposition") ?? "";
if (!disposition.includes("attachment")) fail("export is not served as a download");
const exportHtml = await exportRes.text();
if (!exportHtml.includes('id="hermetic-spec"')) fail("export missing inline spec block");
if (exportHtml.includes('href="/assets'))
  fail("export references server assets — not self-contained");
const embedded = JSON.parse(
  exportHtml
    .match(/<script type="application\/json" id="hermetic-spec">([\s\S]*?)<\/script>/)[1]
    .replace(/<\\\//g, "</")
);
if (embedded.root !== spec.root) fail("export embedded a different spec than persisted");
if (JSON.stringify(embedded).includes('"__cost"')) fail("export leaked __-internal state");
console.error(
  `✔ single-file export: ${(exportHtml.length / 1024 / 1024).toFixed(1)}MB, ` +
    `bundle=${exportRes.headers.get("x-hermetic-export-bundle")}`
);

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
