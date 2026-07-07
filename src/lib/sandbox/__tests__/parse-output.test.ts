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
    if (!by137.success) expect(by137.error).toContain("Out of memory");

    const byKilled = await parseSandboxOutput({
      ...base,
      exitCode: 1,
      readFile: io({ "/data/stderr.txt": "Killed" }),
    });
    expect(byKilled.success).toBe(false);
    if (!byKilled.success) expect(byKilled.error).toContain("Out of memory");
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
