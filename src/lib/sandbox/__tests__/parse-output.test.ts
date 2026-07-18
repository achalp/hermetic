import { describe, it, expect } from "vitest";
import { parseSandboxOutput, parseJsonWithPythonNonFinite } from "@/lib/sandbox/parse-output";

/** In-memory readFile adapter: a map of path → content (missing = null). */
function io(files: Record<string, string>) {
  return (path: string) => Promise.resolve(files[path] ?? null);
}

const base = { runtime: "test", executionMs: 42, exitCode: 0 };

describe("parseSandboxOutput", () => {
  it("parses output.json into a success envelope", async () => {
    const result = await parseSandboxOutput({
      ...base,
      readFile: io({
        "/data/output.json": JSON.stringify({
          results: { total: 5 },
          chart_data: { main: [{ x: 1 }] },
          datasets: { main: [{ a: 1 }] },
        }),
      }),
    });
    expect(result).toMatchObject({
      success: true,
      results: { total: 5 },
      chart_data: { main: [{ x: 1 }] },
      datasets: { main: [{ a: 1 }] },
      execution_ms: 42,
    });
  });

  it("falls back to stdout.txt when output.json is absent or empty", async () => {
    const result = await parseSandboxOutput({
      ...base,
      readFile: io({
        "/data/output.json": "   ",
        "/data/stdout.txt": JSON.stringify({ results: { n: 1 }, chart_data: {} }),
      }),
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.results).toEqual({ n: 1 });
  });

  it("respects a custom workDir (microsandbox per-query dirs)", async () => {
    const result = await parseSandboxOutput({
      ...base,
      workDir: "/data/q1",
      readFile: io({ "/data/q1/output.json": JSON.stringify({ results: {}, chart_data: {} }) }),
    });
    expect(result.success).toBe(true);
  });

  it("returns the no-output error when neither file has content", async () => {
    const result = await parseSandboxOutput({ ...base, readFile: io({}) });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("Code produced no output");
  });

  it("reports stderr on a nonzero exit code", async () => {
    const result = await parseSandboxOutput({
      ...base,
      exitCode: 1,
      readFile: io({ "/data/stderr.txt": "NameError: name 'x' is not defined" }),
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("NameError");
  });

  it("detects OOM on exit 137 and on a bare 'Killed' — for EVERY runtime", async () => {
    // Regression: OOM detection existed only on the Docker path; the same
    // failure on microsandbox/E2B returned a raw stderr dump.
    const by137 = await parseSandboxOutput({ ...base, exitCode: 137, readFile: io({}) });
    expect(by137.success).toBe(false);
    if (!by137.success) {
      expect(by137.error).toContain("Out of memory");
      expect(by137.errorKind).toBe("oom");
    }

    const byKilled = await parseSandboxOutput({
      ...base,
      exitCode: 1,
      readFile: io({ "/data/stderr.txt": "Killed" }),
    });
    expect(byKilled.success).toBe(false);
    if (!byKilled.success) {
      expect(byKilled.error).toContain("Out of memory");
      expect(byKilled.errorKind).toBe("oom");
    }
  });

  it("surfaces the watchdog's predicted-OOM message verbatim (escalation over generic OOM)", async () => {
    // The memory guard (assert_fits / watchdog) fast-fails with a marker line
    // carrying the exact "switch to DOESN'T-FIT" guidance — the retry must see
    // THAT, not the generic 'pull fewer columns' text that diverges.
    const stderr =
      "some earlier log\n" +
      "HERMETIC_OOM_PREDICTED: memory reached 91% of the 4.3 GB cap — aborting before the OOM-kill. " +
      "SWITCH STRATEGY: COUNT in DuckDB and go coarse-to-fine.\n";
    const predicted = await parseSandboxOutput({
      ...base,
      exitCode: 137,
      readFile: io({ "/data/stderr.txt": stderr }),
    });
    expect(predicted.success).toBe(false);
    if (!predicted.success) {
      expect(predicted.errorKind).toBe("oom");
      expect(predicted.error).toContain("HERMETIC_OOM_PREDICTED");
      expect(predicted.error).toContain("SWITCH STRATEGY");
      // The generic message is NOT used when a prediction marker is present.
      expect(predicted.error).not.toContain("Do NOT load millions of rows");
    }
  });

  it("gives phase-SPECIFIC OOM guidance from the watchdog's [phase=...] tag", async () => {
    // The watchdog tags the abort with the progress phase where memory peaked,
    // so the retry gets a fix for THAT step, not a generic blob it already did.
    const stderr =
      "HERMETIC_OOM_PREDICTED: [phase=materializing simplified USA polygon] memory reached 90% of the 4.3 GB cap — aborting before the OOM-kill. " +
      "SWITCH STRATEGY: COUNT in DuckDB.\n";
    const res = await parseSandboxOutput({
      ...base,
      exitCode: 137,
      readFile: io({ "/data/stderr.txt": stderr }),
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.errorKind).toBe("oom");
      expect(res.error).toContain("materializing simplified USA polygon");
      // POLYGON hint — names the ST_Union_Agg / simplify remedy, not the generic.
      expect(res.error).toContain("ST_Union_Agg");
      expect(res.error).not.toContain("[phase=");
    }
  });

  it("recovers the OOM phase from the last stdout progress line on a hard kernel kill", async () => {
    // No watchdog marker (exit 137, bare 'Killed') — but the progress heartbeat
    // left the last phase in stdout, which localizes the OOM to the grid scan.
    const stdout =
      '{"__progress": {"phase": "counting occupied grid cells", "elapsed_ms": 5000}}\n' +
      "some later noise\n";
    const res = await parseSandboxOutput({
      ...base,
      exitCode: 137,
      readFile: io({ "/data/stderr.txt": "Killed", "/data/stdout.txt": stdout }),
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.errorKind).toBe("oom");
      expect(res.error).toContain("counting occupied grid cells");
      // GRID hint — the cell-size-to-span fix.
      expect(res.error).toContain("span_m/200");
    }
  });

  it("falls back to the generic OOM message when the phase is unknown/unmatched", async () => {
    // A phase tag that matches no rule → verbatim marker (tag stripped), and a
    // bare kill with no progress → the generic two-case guidance.
    const unmatched = await parseSandboxOutput({
      ...base,
      exitCode: 137,
      readFile: io({
        "/data/stderr.txt":
          "HERMETIC_OOM_PREDICTED: [phase=doing something opaque] memory reached 88% of the cap. SWITCH STRATEGY: x.\n",
      }),
    });
    expect(unmatched.success).toBe(false);
    if (!unmatched.success) {
      expect(unmatched.error).toContain("SWITCH STRATEGY");
      expect(unmatched.error).not.toContain("[phase=");
    }

    const bare = await parseSandboxOutput({
      ...base,
      exitCode: 137,
      readFile: io({ "/data/stderr.txt": "Killed" }),
    });
    expect(bare.success).toBe(false);
    if (!bare.success) expect(bare.error).toContain("Do NOT load millions of rows");
  });

  it("uses the stderr fallback when the stderr file is unreadable", async () => {
    const result = await parseSandboxOutput({
      ...base,
      exitCode: 1,
      readFile: io({}),
      stderrFallback: "sdk-level stderr",
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toBe("sdk-level stderr");
  });

  it("tolerates bare Python NaN/Infinity tokens in the JSON", async () => {
    const result = await parseSandboxOutput({
      ...base,
      readFile: io({
        "/data/output.json": '{"results": {"mean": NaN, "max": Infinity}, "chart_data": {}}',
      }),
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.results).toEqual({ mean: null, max: null });
  });

  it("returns a parse error with an excerpt for non-JSON output", async () => {
    const result = await parseSandboxOutput({
      ...base,
      readFile: io({ "/data/output.json": "Traceback (most recent call last): boom" }),
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("Failed to parse output as JSON");
  });

  it("does NOT corrupt legitimate strings containing NaN/Infinity tokens", async () => {
    // Regression: the unconditional \bNaN\b→null regex over the raw JSON
    // turned "NaN Zhu" into "null Zhu" and "Infinity Ward" into "null Ward"
    // in user-visible results.
    const result = await parseSandboxOutput({
      ...base,
      readFile: io({
        "/data/output.json": JSON.stringify({
          results: { top_author: "NaN Zhu", studio: "Infinity Ward" },
          chart_data: {},
        }),
      }),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.results).toEqual({ top_author: "NaN Zhu", studio: "Infinity Ward" });
    }
  });
});

describe("envelope shape validation (write_output contract)", () => {
  it("rejects a non-object results with a precise, retry-feedable message", async () => {
    const result = await parseSandboxOutput({
      ...base,
      readFile: io({
        "/data/output.json": JSON.stringify({ results: "none", chart_data: {} }),
      }),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("wrong shape for write_output");
      expect(result.error).toContain("results");
    }
  });

  it("rejects datasets that are not arrays of row objects", async () => {
    const result = await parseSandboxOutput({
      ...base,
      readFile: io({
        "/data/output.json": JSON.stringify({
          results: {},
          chart_data: {},
          datasets: { main: "oops" },
        }),
      }),
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("datasets");
  });

  it("tolerates missing keys (lenient on absence, strict on wrong types)", async () => {
    const result = await parseSandboxOutput({
      ...base,
      readFile: io({ "/data/output.json": JSON.stringify({ results: { n: 1 } }) }),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.chart_data).toEqual({});
      expect(result.images).toEqual({});
      expect(result.datasets).toBeUndefined();
    }
  });
});

describe("parseJsonWithPythonNonFinite", () => {
  it("returns valid JSON untouched (strings with NaN/Infinity survive)", () => {
    const obj = { name: "NaN Zhu", studio: "Infinity Ward", v: 1 };
    expect(parseJsonWithPythonNonFinite(JSON.stringify(obj))).toEqual(obj);
  });

  it("sanitizes bare Python non-finite tokens only when strict parsing fails", () => {
    expect(parseJsonWithPythonNonFinite('{"a": NaN, "b": Infinity, "c": -Infinity}')).toEqual({
      a: null,
      b: null,
      c: null,
    });
  });

  it("still throws on unparseable text", () => {
    expect(() => parseJsonWithPythonNonFinite("not json at all")).toThrow();
  });
});
