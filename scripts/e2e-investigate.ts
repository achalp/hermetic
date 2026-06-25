/**
 * API-level end-to-end test for a warehouse Investigate run. Registers the
 * BigQuery connection from .env.local, runs a real investigation against the
 * live dev server, consumes the JSONL stream, and asserts the invariants we've
 * been fixing — WITHOUT a browser. Costs a real LLM + BigQuery + Docker run.
 *
 *   pnpm dev                       # (a dev server must be running)
 *   npx tsx scripts/e2e-investigate.ts "<question>" <purpose> <datasetMatch>
 *
 * Uses the full, valid connection config from .warehouse-connections.json
 * (the multi-line service-account JSON survives there; --env-file mangles it).
 *
 * Invariants checked:
 *   - investigation did not abort (no /state/__error)
 *   - NO raw "$result:"/"$chartData:" token leaked into the streamed spec
 *   - grounding produced no ungrounded ("untraceable") figures
 *   - the dashboard composed ≥1 chart component
 *   - the artifacts trail is retrievable and carries per-step code
 */

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const QUESTION =
  process.argv[2] ??
  "Do companies in the same industry report similar financial metrics, and which industries show the most variation?";
const PURPOSE = process.argv[3] ?? "brief";
const DATASET_MATCH = process.argv[4] ?? "sec_quarterly_financials";

function ok(cond: boolean, label: string, detail = ""): boolean {
  console.log(`${cond ? "✅ PASS" : "❌ FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  return cond;
}

async function main() {
  // ── 1. Register the warehouse from the persisted config (headless — no UI) ──
  const { readFile } = await import("node:fs/promises");
  const conns = JSON.parse(await readFile(".warehouse-connections.json", "utf-8")) as {
    config: { type: string; dataset?: string; projectId?: string; credentialsJson?: string };
  }[];
  const picked = conns.find((c) => (c.config.dataset ?? "").includes(DATASET_MATCH));
  if (!picked) throw new Error(`No saved connection matching dataset "${DATASET_MATCH}"`);
  const connectBody = picked.config;
  console.log(`▶ connecting ${connectBody.type} ${connectBody.projectId}.${connectBody.dataset} …`);
  const cRes = await fetch(`${BASE}/api/warehouse/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(connectBody),
  });
  const cJson = (await cRes.json()) as Record<string, unknown>;
  if (!cRes.ok || !cJson.warehouse_id) throw new Error(`connect failed: ${JSON.stringify(cJson)}`);
  const warehouseId = cJson.warehouse_id as string;
  console.log(`  connected: ${cJson.table_count} tables, ${cJson.total_columns} columns\n`);

  // ── 2. Run the investigation, streaming the JSONL patches ──
  console.log(`▶ investigating (${PURPOSE}): "${QUESTION}"`);
  const t0 = Date.now();
  const iRes = await fetch(`${BASE}/api/query/investigate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      context: { warehouse_id: warehouseId, question: QUESTION, purpose: PURPOSE },
    }),
  });
  if (!iRes.ok || !iRes.body) throw new Error(`investigate HTTP ${iRes.status}`);

  const reader = iRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastStage = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // surface progress stages live so the multi-minute run isn't silent
    const stageMatch = [...buffer.matchAll(/"stage":"([^"]+)"/g)].pop();
    if (stageMatch && stageMatch[1] !== lastStage) {
      lastStage = stageMatch[1];
      process.stdout.write(`  · ${lastStage}\n`);
    }
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`  stream closed after ${secs}s\n`);

  // ── 3. Parse the stream + assert invariants ──
  const patches = buffer
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith(":"))
    .map((l) => {
      try {
        return JSON.parse(l) as { op?: string; path?: string; value?: unknown };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as { op?: string; path?: string; value?: unknown }[];

  const lastValueAt = (path: string) =>
    patches
      .filter((p) => p.path === path)
      .map((p) => p.value)
      .pop();

  const error = lastValueAt("/state/__error");
  const grounding = lastValueAt("/state/__grounding") as { ungrounded?: string[] } | undefined;
  const cost = lastValueAt("/state/__cost") as { costUsd?: number; llmCalls?: number } | undefined;
  const csvId = lastValueAt("/state/__warehouse_csv_id") as string | undefined;

  const rawPlaceholder = /\$(?:result|chartData):/.exec(buffer);
  const chartComponents = [
    ...buffer.matchAll(
      /"(BarChart|LineChart|ScatterChart|HeatMap|Histogram|ParetoChart|ECDFChart|PieChart|AreaChart|DataTable|StatCard)"/g
    ),
  ].map((m) => m[1]);

  let trailSteps = 0;
  let trailHasCode = false;
  if (csvId) {
    const aRes = await fetch(`${BASE}/api/artifacts/${csvId}`);
    if (aRes.ok) {
      const a = (await aRes.json()) as {
        investigation?: { steps?: { code?: string }[] };
      };
      const steps = a.investigation?.steps ?? [];
      trailSteps = steps.length;
      trailHasCode = steps.some((s) => !!s.code);
    }
  }

  console.log("── invariants ──");
  const results = [
    ok(!error, "investigation did not abort", error ? String(error).slice(0, 120) : ""),
    ok(
      !rawPlaceholder,
      "no raw $result:/$chartData: leaked to the spec",
      rawPlaceholder?.[0] ?? ""
    ),
    ok(
      !grounding?.ungrounded?.length,
      "no ungrounded ('untraceable') figures",
      grounding?.ungrounded?.length ? grounding.ungrounded.join(", ") : ""
    ),
    ok(
      chartComponents.length > 0,
      "dashboard composed ≥1 chart",
      `${chartComponents.length} components`
    ),
    ok(
      trailSteps > 0 && trailHasCode,
      "artifacts trail retrievable with per-step code",
      `${trailSteps} steps`
    ),
  ];

  console.log(
    `\ncost: $${cost?.costUsd?.toFixed(4) ?? "?"} · ${cost?.llmCalls ?? "?"} LLM calls · csvId ${csvId ?? "(none)"}`
  );
  // Save the raw stream for inspection.
  const { writeFileSync } = await import("node:fs");
  writeFileSync("/tmp/e2e-stream.jsonl", buffer);
  console.log("raw stream saved to /tmp/e2e-stream.jsonl");

  const passed = results.every(Boolean);
  console.log(`\n${passed ? "✅ ALL INVARIANTS PASSED" : "❌ SOME INVARIANTS FAILED"}`);
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error("E2E error:", err instanceof Error ? err.message : err);
  process.exit(2);
});
