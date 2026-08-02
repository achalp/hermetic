// Modularization ratchet — counts known design-flaw instances and fails CI
// if any count INCREASES over the committed baseline. Baselines only go down.
//
//   node scripts/ratchet.mjs            check against scripts/ratchet-baseline.json
//   node scripts/ratchet.mjs --update   rewrite the baseline with current counts
//
// Metric definitions and targets: specs/modularization-phase-1-implementation-plan-2026-08-01.md §1.4
// Phase 1 is complete when every metric reads 0.

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = join(ROOT, "scripts", "ratchet-baseline.json");

const STREAM_KEYS =
  "progress|runId|exec|estimate|cost|warehouse_csv_id|plan|cells|results|chart_data|dataQuality|grounding|synthesis|error";

/** @type {Array<{id: string, why: string, dirs: string[], excludeDirs?: string[], excludeFiles?: RegExp, pattern: RegExp, distinct?: boolean}>} */
const METRICS = [
  {
    id: "lib-process-env",
    why: "lib must receive config via HermeticConfig, not read the environment",
    dirs: ["src/lib"],
    pattern: /process\.env\b/g,
  },
  {
    id: "lib-process-cwd",
    why: "lib must receive paths via HermeticPaths, not assume the working directory",
    dirs: ["src/lib"],
    pattern: /process\.cwd\(/g,
  },
  {
    id: "lib-globalthis-stores",
    why: "process-global singleton stores; state belongs behind StateStore",
    dirs: ["src/lib"],
    pattern: /globalThis(\.| as )/g,
  },
  {
    id: "server-only-imports",
    why: "runtime marker that throws under plain Node; boundaries are lint-enforced instead",
    dirs: ["src"],
    pattern: /import\s+"server-only"/g,
  },
  {
    id: "app-raw-fetch",
    why: "app-layer network calls must go through the typed client in lib/api.ts",
    dirs: ["src/components/app", "src/hooks", "src/app"],
    excludeDirs: ["src/app/api"],
    pattern: /\bfetch\(/g,
  },
  {
    id: "api-boundary-casts",
    why: "double-casts standing in for shared request/response types",
    dirs: ["src/components/app", "src/hooks", "src/app"],
    excludeDirs: ["src/app/api"],
    pattern: /as unknown as/g,
  },
  {
    id: "json-render-imports",
    why: "the spec contract moves in-house (WS2); no imports of the external package remain",
    dirs: ["src"],
    pattern: /from\s+["']@json-render\//g,
  },
  {
    id: "untyped-stream-state-reads",
    why: "the __-key wire protocol must be read via the typed StreamState module only",
    dirs: ["src/components", "src/hooks", "src/app"],
    excludeDirs: ["src/app/api"],
    pattern: new RegExp(`(?:\\.|\\[")__(?:${STREAM_KEYS})\\b`, "g"),
  },
  {
    id: "boundary-lint-suppressions",
    why: "layer-boundary violations must be fixed, not suppressed",
    dirs: ["src"],
    pattern: /eslint-disable[^\n]*no-restricted-imports/g,
  },
];

const SKIP_DIRS = new Set(["node_modules", "__tests__", ".next"]);
const TEST_FILE = /\.(test|spec)\.[jt]sx?$/;
const SOURCE_FILE = /\.[jt]sx?$/;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(join(dir, entry.name));
    } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

function countMetric(metric) {
  const excluded = (metric.excludeDirs ?? []).map((d) => join(ROOT, d));
  const distinctValues = new Set();
  let count = 0;
  const perFile = new Map();
  for (const dir of metric.dirs) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs)) {
      if (excluded.some((e) => file.startsWith(e + "/") || file === e)) continue;
      if (metric.excludeFiles?.test(file)) continue;
      const text = readFileSync(file, "utf8");
      const matches = [...text.matchAll(metric.pattern)];
      if (matches.length === 0) continue;
      if (metric.distinct) {
        for (const m of matches) distinctValues.add(m[1] ?? m[0]);
      } else {
        count += matches.length;
      }
      perFile.set(relative(ROOT, file), matches.length);
    }
  }
  return { count: metric.distinct ? distinctValues.size : count, perFile };
}

const update = process.argv.includes("--update");
const verbose = process.argv.includes("--verbose");

const results = METRICS.map((m) => ({ metric: m, ...countMetric(m) }));

if (update) {
  const baseline = Object.fromEntries(results.map((r) => [r.metric.id, r.count]));
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`Baseline written to ${relative(ROOT, BASELINE_PATH)}`);
}

const baseline = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : null;

if (!baseline) {
  console.error("No baseline found. Run: node scripts/ratchet.mjs --update");
  process.exit(1);
}

let failed = false;
let improved = false;
const pad = (s, n) => String(s).padEnd(n);
console.log(`\n${pad("metric", 30)} ${pad("baseline", 9)} ${pad("now", 6)} status`);
for (const r of results) {
  const base = baseline[r.metric.id];
  const status =
    base === undefined
      ? "NEW (add to baseline)"
      : r.count > base
        ? "FAIL — regression"
        : r.count < base
          ? "improved — run --update to lock in"
          : "ok";
  if (base === undefined || r.count > base) failed = true;
  if (base !== undefined && r.count < base) improved = true;
  console.log(`${pad(r.metric.id, 30)} ${pad(base ?? "—", 9)} ${pad(r.count, 6)} ${status}`);
  if ((verbose || r.count > (base ?? Infinity)) && r.perFile.size) {
    for (const [file, n] of [...r.perFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`    ${n
        .toString()
        .padStart(4)}  ${file}`);
    }
  }
}

if (failed) {
  console.error(
    "\nRatchet failed: a design-flaw count increased (or a new metric lacks a baseline)." +
      "\nFix the regression — do not update the baseline upward." +
      "\nMetric rationale: specs/modularization-phase-1-implementation-plan-2026-08-01.md §1.4"
  );
  process.exit(1);
}
if (improved && !update) {
  console.log("\nCounts improved — commit a tightened baseline: node scripts/ratchet.mjs --update");
}
console.log("\nRatchet ok.");
