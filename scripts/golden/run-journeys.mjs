// Golden-transcript journey runner (modularization M0-0b).
//
// Drives core user journeys over HTTP against a RUNNING hermetic server and
// captures the full NDJSON patch stream for each, normalized to be
// deterministic. Goldens are the contract every "move, don't improve"
// refactor PR must preserve byte-for-byte.
//
// Usage:
//   1. Start the server with the LLM record/replay layer active:
//        HERMETIC_LLM_MODE=record pnpm dev     (first time — real LLM, real key)
//        HERMETIC_LLM_MODE=replay pnpm dev     (thereafter — no network, no key)
//   2. Record goldens:   node scripts/golden/run-journeys.mjs record
//      Check against them: node scripts/golden/run-journeys.mjs check
//      One journey only:   node scripts/golden/run-journeys.mjs check ask-basic
//
// Record once with HERMETIC_LLM_MODE=record (writes test-fixtures/llm/ AND
// test-fixtures/golden/), commit both, and from then on CI checks run fully
// offline: replay server + `check`.
//
// Journey coverage vs implementation-plan §1.2: ask-basic (1), investigate
// (4), ask-followup (6). Remaining journeys land as additive recordings:
// retry-loop (2, needs a failure-inducing fixture), warehouse (3, needs the
// stub connector), reruns (5), reattach (7), history/saved (8).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { normalizeTranscript } from "./normalize.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GOLDEN_DIR = join(ROOT, "test-fixtures", "golden");
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";

// ── journeys ────────────────────────────────────────────────────────────────

const CSV_FIXTURE = join(ROOT, "test-specs", "data", "01-saas-mrr.csv");

const JOURNEYS = [
  {
    id: "ask-basic",
    run: async () => {
      const csvId = await uploadCSV(CSV_FIXTURE);
      return streamNDJSON("/api/query", {
        prompt: "",
        context: { csv_id: csvId, question: "What is the MRR trend over time?" },
      });
    },
  },
  {
    id: "ask-followup",
    run: async () => {
      const csvId = await uploadCSV(CSV_FIXTURE);
      await streamNDJSON("/api/query", {
        prompt: "",
        context: { csv_id: csvId, question: "What is the MRR trend over time?" },
      });
      // Second question on the same csv — exercises the conversation cache.
      return streamNDJSON("/api/query", {
        prompt: "",
        context: { csv_id: csvId, question: "Which month had the largest MRR jump, and why?" },
      });
    },
  },
  {
    id: "investigate",
    run: async () => {
      const csvId = await uploadCSV(CSV_FIXTURE);
      return streamNDJSON("/api/query/investigate", {
        context: { csv_id: csvId, question: "Investigate what drives churn in this data." },
      });
    },
  },
];

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function uploadCSV(path) {
  const form = new FormData();
  const bytes = readFileSync(path);
  form.append("csv", new Blob([bytes], { type: "text/csv" }), "fixture.csv");
  const res = await fetch(`${BASE}/api/upload`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  if (!body.csv_id) throw new Error(`upload returned no csv_id: ${JSON.stringify(body)}`);
  return body.csv_id;
}

async function streamNDJSON(route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${route} failed: ${res.status} ${await res.text()}`);
  const text = await new Response(res.body).text();
  return text.split("\n");
}

// ── main ────────────────────────────────────────────────────────────────────

const mode = process.argv[2];
const only = process.argv[3];

if (mode !== "record" && mode !== "check") {
  console.error("usage: node scripts/golden/run-journeys.mjs <record|check> [journey-id]");
  process.exit(2);
}

const selected = JOURNEYS.filter((j) => !only || j.id === only);
if (selected.length === 0) {
  console.error(`unknown journey: ${only}. Known: ${JOURNEYS.map((j) => j.id).join(", ")}`);
  process.exit(2);
}

// Cost guard: journeys drive real LLM calls unless the target server runs in
// replay mode. The runner cannot introspect the server's mode, so it requires
// the operator's environment to declare it: HERMETIC_LLM_MODE=replay (the CI
// flow exports it for both server and runner), HERMETIC_LLM_MODE=record for a
// deliberate paid recording pass, or an explicit --allow-live override.
const runnerMode = process.env.HERMETIC_LLM_MODE;
const allowLive = process.argv.includes("--allow-live");
if (runnerMode !== "replay" && runnerMode !== "record" && !allowLive) {
  console.error(
    "Refusing to run: HERMETIC_LLM_MODE is not set in this environment.\n" +
      "Journeys spend real LLM tokens against a live-mode server. Either export\n" +
      "HERMETIC_LLM_MODE=replay|record to match the server you started, or pass\n" +
      "--allow-live to knowingly drive a live server."
  );
  process.exit(2);
}

// Fail fast if the server isn't up.
try {
  await fetch(`${BASE}/api/providers`);
} catch {
  console.error(`No server at ${BASE}. Start one first (see header comment).`);
  process.exit(2);
}

let failed = false;
for (const journey of selected) {
  const goldenPath = join(GOLDEN_DIR, `${journey.id}.ndjson`);
  process.stdout.write(`journey ${journey.id} ... `);
  const started = Date.now();
  let normalized;
  try {
    normalized = normalizeTranscript(await journey.run());
  } catch (err) {
    console.log(`ERROR (${err.message})`);
    failed = true;
    continue;
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  if (mode === "record") {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(goldenPath, normalized);
    console.log(`recorded (${normalized.split("\n").length} lines, ${secs}s)`);
    continue;
  }

  if (!existsSync(goldenPath)) {
    console.log(`MISSING golden (${goldenPath}) — run record first`);
    failed = true;
    continue;
  }
  const golden = readFileSync(goldenPath, "utf8");
  if (normalized === golden) {
    console.log(`ok (${secs}s)`);
  } else {
    failed = true;
    const receivedPath = join(GOLDEN_DIR, `${journey.id}.received.ndjson`);
    writeFileSync(receivedPath, normalized);
    const gl = golden.split("\n");
    const rl = normalized.split("\n");
    let i = 0;
    while (i < Math.min(gl.length, rl.length) && gl[i] === rl[i]) i++;
    console.log(`MISMATCH at line ${i + 1} (received written to ${receivedPath})`);
    console.log(`  golden:   ${(gl[i] ?? "<end>").slice(0, 200)}`);
    console.log(`  received: ${(rl[i] ?? "<end>").slice(0, 200)}`);
  }
}

if (failed) {
  console.error(
    "\nGolden check failed. If the change is INTENTIONAL, re-record and commit the diff " +
      "in the same PR (implementation plan §1.5); otherwise this is a regression."
  );
  process.exit(1);
}
console.log("\nGolden transcripts ok.");
