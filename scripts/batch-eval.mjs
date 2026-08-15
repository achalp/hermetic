#!/usr/bin/env node
/**
 * Batch eval: run the same question N times through the LOCAL SERVER and
 * cluster the blind-audit findings by class (whack-a-mole postmortem,
 * 2026-08-13 — discovery moves from one run per sitting to a batch).
 *
 * Every analysis goes through /api/query on the dev server, so it uses
 * whatever transport runtime-config selects — the Claude CLI path runs on
 * the subscription, never direct API credits. Runs are SEQUENTIAL by
 * design: the sandbox and the CLI session are shared resources.
 *
 * Usage:
 *   node scripts/batch-eval.mjs --from-history <id-prefix> [--reps 3]
 *   node scripts/batch-eval.mjs --csv <csvId> --question "..." [--reps 3]
 *   Optional: --server http://localhost:3000  --out batch-evals
 *
 * Output: batch-evals/eval-<stamp>.md (report) and .json (raw) — per-run
 * timing/cost, audit verdicts, and findings clustered by similarity so a
 * defect class appearing in 4 of 5 runs reads as ONE class, not four
 * incidents.
 */

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};

const SERVER = opt("server", "http://localhost:3000");
const REPS = Number(opt("reps", "3"));
const OUT_DIR = opt("out", "batch-evals");

async function getJson(path) {
  const res = await fetch(`${SERVER}${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

async function resolveTarget() {
  const fromHistory = opt("from-history");
  if (fromHistory) {
    const { entries } = await getJson("/api/history");
    const hit = entries.find((e) => e.id.startsWith(fromHistory));
    if (!hit) throw new Error(`no history entry matching ${fromHistory}`);
    return { csvId: hit.csvId, question: hit.question, sourceFile: hit.sourceFile };
  }
  const csvId = opt("csv");
  const question = opt("question");
  if (!csvId || !question) {
    console.error("need --from-history <id> OR --csv <id> --question '...'");
    process.exit(1);
  }
  return { csvId, question };
}

/** Stale csvIds die with a server restart (the CSV store is in-memory; the
 *  source registry persists). Re-attach a remote-parquet source by name and
 *  return the fresh csv_id, or null when nothing matches. */
async function reattachSource(sourceFile) {
  try {
    const { sources } = await getJson("/api/sources/recent");
    // ONLY an exact source-name match may re-attach — a loose fallback once
    // re-attached the 2.5B-row Overture set for a 10-zone question and
    // burned a planet-scale scan on the wrong data.
    if (!sourceFile) return null;
    const hit = (sources ?? []).find((s) => s.kind === "remote-parquet" && s.name === sourceFile);
    if (!hit?.url) return null;
    const res = await fetch(`${SERVER}/api/remote-parquet/schema`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: hit.url }),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body.csv_id ?? null;
  } catch {
    return null;
  }
}

/** Build the spec object from the drained patch lines — the same assembly
 *  the browser client does before it saves history. add/replace only. */
function assembleSpec(lines) {
  const spec = {};
  for (const line of lines) {
    let p;
    try {
      p = JSON.parse(line);
    } catch {
      continue;
    }
    if (p.op !== "add" && p.op !== "replace") continue;
    const segs = String(p.path ?? "")
      .split("/")
      .filter(Boolean);
    if (segs.length === 0) continue;
    let cur = spec;
    for (const s of segs.slice(0, -1)) {
      if (cur[s] === null || typeof cur[s] !== "object") cur[s] = {};
      cur = cur[s];
    }
    cur[segs[segs.length - 1]] = p.value;
  }
  return spec;
}

/** POST /api/query, drain the patch stream, and PERSIST the result: history
 *  saving is client-driven (the browser saves after rendering; the server
 *  only saves on mid-run disconnect), so a headless drain that skips this
 *  loses the whole run — observed on the first geo batch. */
async function runAnalysis(csvId, question) {
  const res = await fetch(`${SERVER}/api/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: question, context: { csv_id: csvId, question } }),
  });
  if (!res.ok || !res.body) throw new Error(`POST /api/query -> ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const spec = assembleSpec(lines);
  const err = spec.state?.__error;
  if (typeof err === "string" && err) throw new Error(`analysis error: ${err}`);
  const save = await fetch(`${SERVER}/api/history/save`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csvId, spec, question }),
  });
  if (!save.ok) console.error(`  history save -> ${save.status}`);
}

async function newestRunSince(question, sinceMs) {
  const { entries } = await getJson("/api/history");
  const hit = entries
    .filter((e) => e.question === question && e.timestamp >= sinceMs)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  return hit?.id;
}

async function audit(historyId) {
  const res = await fetch(`${SERVER}/api/audit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ history_id: historyId }),
  });
  if (!res.ok) return null;
  const body = await res.json();
  return body.audit ?? null;
}

async function runDetails(historyId) {
  try {
    const d = await getJson(`/api/history/${historyId}`);
    const cost = d?.spec?.state?.__cost ?? null;
    const grounding = d?.spec?.state?.__grounding ?? null;
    const verifiability = d?.spec?.state?.__verifiability ?? null;
    return { cost, grounding, verifiability };
  } catch {
    return { cost: null, grounding: null, verifiability: null };
  }
}

// ── Clustering: token-Jaccard over audit claims ──────────────────────

const STOP = new Set(
  "the a an of to in for and or is are was were with over under by from that this its it as on at not no".split(
    " "
  )
);
const tokens = (s) =>
  new Set(
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t))
  );

function jaccard(a, b) {
  const inter = [...a].filter((t) => b.has(t)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

function clusterFindings(all) {
  const clusters = [];
  for (const f of all) {
    const toks = tokens(f.claim);
    const hit = clusters.find((c) => jaccard(c.toks, toks) >= 0.35);
    if (hit) {
      hit.members.push(f);
      for (const t of toks) hit.toks.add(t);
    } else {
      clusters.push({ toks, members: [f] });
    }
  }
  return clusters.sort((a, b) => b.members.length - a.members.length);
}

// ── Main ─────────────────────────────────────────────────────────────

const SEV_RANK = { high: 0, medium: 1, low: 2 };

async function main() {
  const target = await resolveTarget();
  let { csvId } = target;
  const { question } = target;
  console.error(`question: ${question}`);
  console.error(`csv: ${csvId}  reps: ${REPS}  server: ${SERVER}`);

  const runs = [];
  for (let i = 0; i < REPS; i++) {
    const t0 = Date.now();
    console.error(`\n[${i + 1}/${REPS}] running analysis…`);
    try {
      try {
        await runAnalysis(csvId, question);
      } catch (err) {
        // Stale csvId after a server restart → re-attach the source once.
        if (!/CSV not found/i.test(String(err))) throw err;
        const fresh = await reattachSource(target.sourceFile);
        if (!fresh) throw err;
        console.error(`  csv expired; re-attached as ${fresh.slice(0, 8)}`);
        csvId = fresh;
        await runAnalysis(csvId, question);
      }
    } catch (err) {
      console.error(`  run failed: ${err.message}`);
      runs.push({ rep: i + 1, error: String(err) });
      continue;
    }
    const id = await newestRunSince(question, t0 - 5000);
    if (!id) {
      runs.push({ rep: i + 1, error: "run not found in history after stream end" });
      continue;
    }
    console.error(`  history: ${id}  (${((Date.now() - t0) / 1000).toFixed(1)}s) — auditing…`);
    const [auditResult, details] = await Promise.all([audit(id), runDetails(id)]);
    runs.push({
      rep: i + 1,
      id,
      wallMs: details.cost?.wallMs ?? Date.now() - t0,
      costUsd: details.cost?.costUsd ?? null,
      llmCalls: details.cost?.llmCalls ?? null,
      ungrounded: details.grounding?.ungrounded?.length ?? null,
      failedChecks: details.verifiability?.findings?.failedChecks ?? [],
      cited: details.verifiability?.findings?.cited ?? null,
      declared: details.verifiability?.findings?.declared ?? null,
      verdict: auditResult?.verdict ?? "audit-failed",
      findings: (auditResult?.findings ?? []).map((f) => ({
        severity: f.severity,
        claim: f.claim,
        evidence: f.evidence,
      })),
    });
  }

  const ok = runs.filter((r) => !r.error);
  const allFindings = ok.flatMap((r) => r.findings.map((f) => ({ ...f, runId: r.id })));
  allFindings.sort((a, b) => (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3));
  const clusters = clusterFindings(allFindings);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const lines = [];
  lines.push(`# Batch eval — ${stamp}`);
  lines.push("");
  lines.push(`**Question:** ${question}`);
  lines.push(`**Runs:** ${ok.length}/${REPS} completed`);
  lines.push("");
  lines.push("## Runs");
  lines.push("");
  lines.push("| # | id | wall | cost | calls | cited | failed checks | audit |");
  lines.push("|---|----|------|------|-------|-------|---------------|-------|");
  for (const r of runs) {
    if (r.error) {
      lines.push(`| ${r.rep} | — | — | — | — | — | — | ERROR: ${r.error} |`);
      continue;
    }
    lines.push(
      `| ${r.rep} | ${r.id.slice(0, 8)} | ${(r.wallMs / 1000).toFixed(0)}s | $${r.costUsd?.toFixed(2) ?? "?"} | ${r.llmCalls ?? "?"} | ${r.cited ?? "?"}/${r.declared ?? "?"} | ${r.failedChecks.length} | ${r.verdict} (${r.findings.length}) |`
    );
  }
  lines.push("");
  lines.push(
    `## Audit finding clusters (${allFindings.length} findings, ${clusters.length} classes)`
  );
  for (const [i, c] of clusters.entries()) {
    const sev = c.members
      .map((m) => m.severity)
      .sort((a, b) => (SEV_RANK[a] ?? 3) - (SEV_RANK[b] ?? 3))[0];
    lines.push("");
    lines.push(
      `### ${i + 1}. [${sev}] seen in ${new Set(c.members.map((m) => m.runId)).size}/${ok.length} runs`
    );
    lines.push("");
    lines.push(`> ${c.members[0].claim}`);
    lines.push("");
    for (const m of c.members) {
      lines.push(`- (${m.runId.slice(0, 8)}, ${m.severity}) ${m.claim.slice(0, 140)}`);
    }
  }
  lines.push("");

  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(OUT_DIR, { recursive: true });
  const base = `${OUT_DIR}/eval-${stamp}`;
  writeFileSync(`${base}.md`, lines.join("\n"));
  writeFileSync(
    `${base}.json`,
    JSON.stringify({ question, csvId, runs, clusters: undefined }, null, 1)
  );
  console.error(`\nreport: ${base}.md`);
  console.log(lines.join("\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
