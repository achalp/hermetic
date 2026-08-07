/**
 * Executed-Python prelude tests. prelude.test.ts only regex-pins that the
 * pythonNanPrelude() *contains* the expected defs — nothing ever RAN the
 * Python, so a runtime bug (bad escaping, a syntax error, broken NaN
 * coercion) would reach production only at user query time.
 *
 * These pipe PRELUDE + a fixture through the host python3 and assert the
 * emitted output.json. Scope: the write_output envelope contract (NaN/Inf
 * coercion, non-JSON types, the 5000-row dataset cap + _main_total) — pure
 * Python, no pandas required. Skipped when python3 is unavailable.
 */
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pythonNanPrelude } from "@/lib/sandbox/prelude";
import { parseJsonWithPythonNonFinite } from "@/lib/sandbox/parse-output";

const havePython = (() => {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** Run PRELUDE + fixture in python3; return the raw output.json text. */
function runPreludeRaw(fixture: string): string {
  const dir = mkdtempSync(join(tmpdir(), "prelude-test-"));
  try {
    const outPath = join(dir, "output.json");
    // The prelude writes the hardcoded '/data/output.json'; a module-global
    // `open` shim reroutes it (write_output resolves `open` at call time).
    const shim =
      `import builtins as _b\n` +
      `def open(path, *a, **kw):\n` +
      `    return _b.open(${JSON.stringify(outPath)} if path == '/data/output.json' else path, *a, **kw)\n`;
    const script = pythonNanPrelude() + "\n" + shim + "\n" + fixture;
    const scriptPath = join(dir, "script.py");
    writeFileSync(scriptPath, script);
    const proc = spawnSync("python3", [scriptPath], { encoding: "utf-8" });
    if (proc.status !== 0) {
      throw new Error(`python3 failed (${proc.status}): ${proc.stderr}`);
    }
    return readFileSync(outPath, "utf-8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run and strict-parse — write_output's contract is strict JSON output. */
function runPrelude(fixture: string): Record<string, unknown> {
  return JSON.parse(runPreludeRaw(fixture));
}

describe.skipIf(!havePython)("pythonNanPrelude() — executed", () => {
  it("the prelude itself is valid Python (no template-escaping breakage)", () => {
    const out = runPrelude(`write_output(results={'ok': 1})`);
    expect(out.results).toEqual({ ok: 1 });
  });

  it("write_output coerces NaN/Inf to null so the output is strict JSON", () => {
    const out = runPrelude(
      `write_output(results={'mean': float('nan'), 'max': float('inf'), 'min': float('-inf'), 'n': 3})`
    );
    // JSON.parse succeeding already proves allow_nan=False held.
    expect(out.results).toEqual({ mean: null, max: null, min: null, n: 3 });
  });

  it("write_output coerces non-JSON types (sets, tuples, unknown objects)", () => {
    const out = runPrelude(
      `write_output(results={'tags': {'a'}, 'pair': (1, 2)}, chart_data={'main': [(1, 2)]})`
    );
    const results = out.results as Record<string, unknown>;
    expect(results.tags).toEqual(["a"]);
    expect(results.pair).toEqual([1, 2]);
  });

  it("always writes the five top-level keys, even for a bare call", () => {
    const out = runPrelude(`write_output()`);
    // findings joined the envelope with the declared-findings feature
    // (spec §2.1) — empty array for a run that declared nothing.
    expect(Object.keys(out).sort()).toEqual([
      "chart_data",
      "datasets",
      "findings",
      "images",
      "results",
    ]);
    expect(out.findings).toEqual([]);
  });

  it("caps datasets['main'] at 5000 rows and records the true total in _main_total", () => {
    const out = runPrelude(
      `write_output(results={}, datasets={'main': [{'i': i} for i in range(6001)]})`
    );
    const datasets = out.datasets as Record<string, unknown[]>;
    expect(datasets.main).toHaveLength(5000);
    expect((out.results as Record<string, unknown>)._main_total).toBe(6001);
  });

  it("a write_output bypass emits bare NaN — which the Node-side parser then handles", () => {
    // The prelude patches json.dump to allow_nan=True (preventing the Python
    // CRASH), so a script that bypasses write_output emits BARE NaN tokens —
    // invalid strict JSON. The other half of the contract lives Node-side:
    // parseJsonWithPythonNonFinite falls back to token→null on parse failure.
    // This pins the two halves TOGETHER.
    const raw = runPreludeRaw(
      `import json\n` +
        `with open('/data/output.json', 'w') as f:\n` +
        `    json.dump({'results': {'v': float('nan')}, 'chart_data': {}}, f)`
    );
    expect(raw).toContain("NaN");
    expect(() => JSON.parse(raw)).toThrow(); // strict parse fails, as expected
    const parsed = parseJsonWithPythonNonFinite(raw) as Record<string, Record<string, unknown>>;
    expect(parsed.results.v).toBeNull();
  });
});
