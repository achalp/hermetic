#!/usr/bin/env node
// Dead-code ratchet over knip (same contract as scripts/ratchet.mjs): per-
// category finding counts may only DECREASE against the committed baseline.
//
//   node scripts/knip-ratchet.mjs            check against scripts/knip-baseline.json
//   node scripts/knip-ratchet.mjs --update   rewrite the baseline with current counts
//
// Categories that are already ZERO are hard gates forever (unused files,
// unused/unlisted dependencies, unresolved imports). The export/type backlog
// is the pre-adoption inventory — mostly src/spec's deliberate public surface
// for the future @hermetic/spec package — and burns down over time; new dead
// exports cannot be added anywhere without going red.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(ROOT, "scripts", "knip-baseline.json");

let raw;
try {
  raw = execFileSync("pnpm", ["exec", "knip", "--no-exit-code", "--reporter", "json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
} catch (err) {
  console.error(`knip failed to run: ${err.message}`);
  process.exit(1);
}
const report = JSON.parse(raw);

const counts = { files: (report.files ?? []).length };
for (const issue of report.issues ?? []) {
  for (const [key, value] of Object.entries(issue)) {
    if (Array.isArray(value)) counts[key] = (counts[key] ?? 0) + value.length;
  }
}
// `files` also appears inside issues in some reporters — the top-level list is
// authoritative; drop a duplicate per-issue count if both exist.
delete counts.owners; // ownership metadata, not a finding

if (process.argv.includes("--update")) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(counts, null, 2)}\n`);
  console.log(`knip baseline updated: ${JSON.stringify(counts)}`);
  process.exit(0);
}

if (!existsSync(BASELINE_PATH)) {
  console.error(`no baseline at ${BASELINE_PATH} — run with --update once`);
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));

let failed = false;
for (const [key, count] of Object.entries(counts)) {
  const allowed = baseline[key] ?? 0;
  const marker = count > allowed ? "✖" : count < allowed ? "↓" : "=";
  console.log(`${marker} ${key}: ${count} (baseline ${allowed})`);
  if (count > allowed) failed = true;
}
if (failed) {
  console.error(
    "\nknip ratchet FAILED — new dead code (run `pnpm exec knip` for details; " +
      "fix it, or if a finding is a false positive, configure knip.json and " +
      "explain why. Never --update to absorb a regression.)"
  );
  process.exit(1);
}
// Reward shrinkage: tighten the baseline automatically when counts dropped,
// so improvements lock in without a manual --update.
if (Object.entries(counts).some(([k, c]) => c < (baseline[k] ?? 0))) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(counts, null, 2)}\n`);
  console.log("baseline tightened to current (lower) counts");
}
console.log("knip ratchet ok");
