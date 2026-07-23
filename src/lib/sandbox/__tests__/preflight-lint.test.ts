/**
 * Pre-flight undefined-name lint (F821). This is the guard that would have
 * caught attempt-1 of the USA most-isolated run — `cKDTree` used without
 * `from scipy.spatial import cKDTree` — in milliseconds, instead of surfacing as
 * a last-line NameError AFTER a ~10-minute remote scan.
 *
 * Two layers:
 *  - preflightLintError(): pure message shaping (no Docker/Python).
 *  - UNDEFINED_NAME_CHECKER: the in-container Python analyzer. We run it through
 *    host python3 (the stdlib-AST fallback path — pyflakes isn't required to be
 *    installed on the host) to pin its real behavior against fixtures. Skipped
 *    when python3 is unavailable.
 */
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preflightLintError, UNDEFINED_NAME_CHECKER } from "@/lib/sandbox/docker-utils";

describe("preflightLintError (pure message shaping)", () => {
  it("returns null when nothing is wrong", () => {
    expect(preflightLintError({ undefinedNames: [] })).toBeNull();
  });

  it("names the undefined symbols and tells the retry to add the import, not rethink", () => {
    const msg = preflightLintError({
      undefinedNames: [
        { name: "cKDTree", line: 28 },
        { name: "cKDTree", line: 40 }, // de-duplicated in the message
      ],
    });
    expect(msg).toContain("cKDTree");
    expect(msg).toContain("NameError");
    expect(msg).toContain("missing import");
    // It must steer AWAY from changing the analysis approach — this is a slip.
    expect(msg).toMatch(/do NOT change your analysis approach/i);
    // Only one mention of the name (deduped).
    expect(msg!.match(/`cKDTree`/g)?.length).toBe(1);
  });

  it("surfaces a syntax error distinctly", () => {
    const msg = preflightLintError({
      undefinedNames: [],
      syntaxError: { message: "invalid syntax", line: 12 },
    });
    expect(msg).toContain("SyntaxError");
    expect(msg).toContain("invalid syntax");
  });
});

const havePython = (() => {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** Run the checker against `scriptText`, returning its stdout lines. The checker
 *  hardcodes the container path /data/script.py — repoint it at a temp file. */
function runChecker(scriptText: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "lint-test-"));
  try {
    const scriptPath = join(dir, "script.py");
    writeFileSync(scriptPath, scriptText);
    const checker = UNDEFINED_NAME_CHECKER.split("/data/script.py").join(scriptPath);
    const res = spawnSync("python3", ["-c", checker], { encoding: "utf8" });
    expect(res.status).toBe(0);
    return res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A prelude-like header: the injected helpers the generated code uses without
// importing (they must NEVER be flagged), plus binding forms that commonly trip
// naive checkers (comprehension / with-as / except-as / for-targets / walrus).
const PRELUDE_LIKE = `
import numpy as np
import pandas as pd
import duckdb
from math import radians, cos, sqrt
def progress(*a, **k): pass
def write_output(**k): pass
def safe_float(x, default=None): return default
def assert_fits(n, cols=3, **k): pass
data = [1, 2, 3]
squares = [v * v for v in data]
with open("/dev/null") as fh:
    pass
try:
    x = 1
except Exception as err:
    print(err)
for i, row in enumerate(data):
    print(i, row, squares, fh, x)
total = (n := len(data))
print(total, radians, cos, sqrt, np, pd, duckdb)
`;

describe.skipIf(!havePython)("UNDEFINED_NAME_CHECKER (in-container analyzer)", () => {
  it("flags a name used but never imported (the cKDTree slip)", () => {
    const out = runChecker(PRELUDE_LIKE + "\ntree = cKDTree(np.zeros((2, 2)))\n");
    expect(out.some((l) => l.startsWith("UNDEFINED:cKDTree:"))).toBe(true);
  });

  it("does NOT false-flag injected helpers or scoped binding forms", () => {
    // Same header, but WITH the import added → clean.
    const fixed = PRELUDE_LIKE.replace(
      "import duckdb",
      "import duckdb\nfrom scipy.spatial import cKDTree"
    );
    const out = runChecker(fixed + "\ntree = cKDTree(np.zeros((2, 2)))\n");
    expect(out).toEqual([]);
  });

  it("reports a syntax error rather than crashing", () => {
    const out = runChecker("def f(:\n    pass\n");
    expect(out.some((l) => l.startsWith("SYNTAX:"))).toBe(true);
  });
});
