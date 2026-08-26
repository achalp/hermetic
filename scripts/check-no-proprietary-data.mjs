#!/usr/bin/env node
// Proprietary-data guard. Blocks two recurrence modes for the data-leak class
// that put internal business datasets into git history (see the Aug-2026
// history rewrite): (1) any tracked path under data/saved-vizs/, and (2)
// distinctive dataset/column tokens from those datasets appearing in ANY
// tracked file. Runs in CI (lint job) and pre-commit (--staged).
//
// The token list is deliberately SPECIFIC (schema/column identifiers, not the
// bare company name) so it flags real data re-entry, not an incidental mention.
import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const FORBIDDEN_PATH = /(^|\/)data\/saved-vizs\//;
const TOKENS = [
  "vendornav",
  "vendormaps",
  "n_rides_vendornav",
  "n_drivers_vendornav",
  "pct_vendormaps",
  "pct_waze",
  "pct_gmaps",
  "region_rnk",
  "r7_compliance",
  "reroute_cost_per_ride",
  "infotainment_usage_dashboard",
];
const TOKEN_RE = new RegExp(
  TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "i"
);
const SKIP_EXT = /\.(png|jpg|jpeg|gif|webp|ico|pdf|woff2?|ttf|eot|parquet|node|wasm)$/i;
const SELF = "scripts/check-no-proprietary-data.mjs";

const staged = process.argv.includes("--staged");
const listCmd = staged ? "git diff --cached --name-only --diff-filter=ACM" : "git ls-files";
const files = execSync(listCmd, { encoding: "utf8" }).split("\n").filter(Boolean);

const problems = [];
for (const f of files) {
  if (FORBIDDEN_PATH.test(f)) {
    problems.push(`${f}: forbidden path (data/saved-vizs/ must never be tracked)`);
    continue;
  }
  if (f === SELF || SKIP_EXT.test(f) || f.endsWith("lock.yaml") || f.endsWith("lock.json"))
    continue;
  let text;
  try {
    if (statSync(f).size > 5_000_000) continue;
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  if (!TOKEN_RE.test(text)) continue;
  text.split("\n").forEach((line, i) => {
    if (TOKEN_RE.test(line))
      problems.push(`${f}:${i + 1}: proprietary data token — ${line.trim().slice(0, 80)}`);
  });
}

if (problems.length) {
  console.error("✖ Proprietary-data guard failed:\n" + problems.map((p) => "  " + p).join("\n"));
  console.error(
    "\nThese tokens/paths indicate internal business data. Do NOT commit. See CONTRIBUTING.md."
  );
  process.exit(1);
}
console.log(
  `✓ Proprietary-data guard: ${files.length} ${staged ? "staged" : "tracked"} files clean.`
);
