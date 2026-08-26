#!/usr/bin/env node
// Data-hygiene guard. Real datasets must never be tracked: `data/` is
// git-ignored except `data/test-fixtures/`, and saved dashboards/sources
// (`data/saved-vizs/`) must never be committed. This guard is content-agnostic
// — it enforces WHERE data may live, not WHAT it contains — and runs in CI
// (lint job) and pre-commit (--staged), catching `git add -f` bypasses of
// .gitignore. Sample data in tests must be synthetic and live in a fixtures dir.
import { execSync } from "node:child_process";

const staged = process.argv.includes("--staged");
const files = execSync(
  staged ? "git diff --cached --name-only --diff-filter=ACM" : "git ls-files",
  { encoding: "utf8" }
)
  .split("\n")
  .filter(Boolean);

const problems = [];
for (const f of files) {
  if (/(^|\/)saved-vizs\//.test(f))
    problems.push(`${f}: saved dashboards/sources must never be tracked`);
  else if (/^data\//.test(f) && !/^data\/test-fixtures\//.test(f))
    problems.push(`${f}: only data/test-fixtures/ may be tracked under data/`);
}

if (problems.length) {
  console.error("✖ Data-hygiene guard failed:\n" + problems.map((p) => "  " + p).join("\n"));
  console.error("\nDatasets do not belong in the repository. See CONTRIBUTING.md > Data hygiene.");
  process.exit(1);
}
console.log(`✓ Data-hygiene guard: ${files.length} ${staged ? "staged" : "tracked"} files clean.`);
