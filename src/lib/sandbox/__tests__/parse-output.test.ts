import { describe, it, expect } from "vitest";
import { parseSandboxOutput, parseJsonWithPythonNonFinite } from "@/lib/sandbox/parse-output";

/** In-memory readFile adapter: a map of path → content (missing = null). */
function io(files: Record<string, string>) {
  return (path: string) => Promise.resolve(files[path] ?? null);
}

const base = { runtime: "test", executionMs: 42, exitCode: 0 };

// The geo phase hints now live on the built-in skills (parse-output keeps only
// the generic MATERIALIZE hint + a generic hard-kill fallback). Tests that
// exercise geo routing pass the REAL built-in hints, like the orchestrator does.
import { activateSkills } from "@/lib/skills/registry";
const GEO_HINTS = activateSkills(
  {
    schema: {
      filename: "b.parquet",
      row_count: 1,
      columns: [{ name: "geometry", dtype: "object", sample_values: [] }],
    } as never,
  },
  { builtinOnly: true }
).failureHints;

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

  it("passes through analysis-product and completeness fields", async () => {
    const series = [
      {
        id: "s1",
        rows: [{ year: 2000, v: 1 }],
        roles: { x: { column: "year", kind: "temporal" }, measures: [{ column: "v" }] },
      },
    ];
    const values = [{ key: "total", value: 42, label: "Total" }];
    const result = await parseSandboxOutput({
      ...base,
      readFile: io({
        "/data/output.json": JSON.stringify({
          results: { total: 42 },
          chart_data: { s1: [{ year: 2000, v: 1 }] },
          series,
          values,
          data_completeness: { time_min: 2000 },
          runtime_fallback: "ImportError: nope",
        }),
      }),
    });
    // series/values ride the envelope raw; data_completeness/runtime_fallback
    // must reach the result too (they were once validated then dropped, which
    // silently disabled the completeness lints and fallback surfacing).
    expect(result).toMatchObject({
      success: true,
      series,
      values,
      data_completeness: { time_min: 2000 },
      runtime_fallback: "ImportError: nope",
    });
  });

  it("preserves declared payloads (finding M2 — zod used to strip them, breaking licensing)", async () => {
    const payloads = [
      { id: "dendro_1", format: "linkage" },
      { id: "tree_2", format: "newick" },
    ];
    const result = await parseSandboxOutput({
      ...base,
      readFile: io({
        "/data/output.json": JSON.stringify({
          results: {},
          chart_data: {},
          payloads,
        }),
      }),
    });
    expect(result.success).toBe(true);
    // Without `payloads` in the envelope schema, zod dropped the key and
    // declare_dendrogram licensing was always empty.
    expect((result as unknown as { payloads?: unknown }).payloads).toEqual(payloads);
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

  it("classifies a remote-read connection failure as errorKind 'network' (fast-fail, not retry)", async () => {
    const result = await parseSandboxOutput({
      ...base,
      exitCode: 1,
      readFile: io({
        "/data/stderr.txt":
          "duckdb.duckdb.IOException: IO Error: Could not establish connection error for HTTP GET to 's3://bucket/x.parquet'",
      }),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorKind).toBe("network");
      expect(result.error).toMatch(/remote data source|network\/egress/i);
    }
  });

  it("does NOT misclassify an ordinary code error as network (stays retryable)", async () => {
    const result = await parseSandboxOutput({
      ...base,
      exitCode: 1,
      readFile: io({ "/data/stderr.txt": "KeyError: 'churn_mrr'" }),
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.errorKind).toBeUndefined();
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
      skillFailureHints: GEO_HINTS,
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.errorKind).toBe("oom");
      expect(res.error).toContain("materializing simplified USA polygon");
      // POLYGON hint — names the ST_Union_Agg / simplify remedy, not the generic.
      expect(res.error).toContain("ST_Union_Agg");
      expect(res.error).toContain("Predicted OOM"); // watchdog lead preserved
      expect(res.error).not.toContain("[phase=");
      expect(res.execDiag).toContain("hint=skill:geo-overture");
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
      skillFailureHints: GEO_HINTS,
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.errorKind).toBe("oom");
      expect(res.error).toContain("counting occupied grid cells");
      // GRID hint — the cell-size-to-span fix.
      expect(res.error).toContain("span_m/200");
      expect(res.execDiag).toContain("hint=skill:planet-scale-superlative");
    }
  });

  it("surfaces the watchdog marker verbatim when its phase tag matches no rule", async () => {
    // A predicted (watchdog) marker with an unmatched phase → verbatim marker
    // (tag stripped). The watchdog only fires on a real pandas-side climb, so its
    // own strategy-switch text is the right guidance.
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
  });

  it("routes a bare 137 kill to the planet-scale SCAN-side fallback hint when geo skills are active", async () => {
    // The scan-buffer diagnosis is planet-scale domain knowledge: it fires via
    // the skill's fallback (catch-all) hint — only on runs where the geo
    // skills activated, never on an ordinary CSV OOM.
    const bare = await parseSandboxOutput({
      ...base,
      exitCode: 137,
      readFile: io({ "/data/stderr.txt": "Killed" }),
      skillFailureHints: GEO_HINTS,
    });
    expect(bare.success).toBe(false);
    if (!bare.success) {
      expect(bare.errorKind).toBe("oom");
      expect(bare.error).toContain("PARALLEL SCAN BUFFERS");
      expect(bare.error).toContain("COARSEN the grid");
      expect(bare.execDiag).toContain("hint=skill:planet-scale-superlative");
    }
  });

  it("routes a bare 137 kill WITHOUT active skills to the generic hard-kill hint", async () => {
    const bare = await parseSandboxOutput({
      ...base,
      exitCode: 137,
      readFile: io({ "/data/stderr.txt": "Killed" }),
    });
    expect(bare.success).toBe(false);
    if (!bare.success) {
      expect(bare.errorKind).toBe("oom");
      expect(bare.error).toContain("HARD kernel OOM-kill");
      // No geo diagnosis on a non-geo run — that was the old misrouting.
      expect(bare.error).not.toContain("PARALLEL SCAN BUFFERS");
      expect(bare.error).not.toContain("COARSEN the grid");
    }
  });

  it("a watchdog-predicted abort is NEVER overridden by a fallback catch-all hint", async () => {
    // The catch-all assumes no watchdog marker; a predicted abort's own
    // message (plus any skill strategy hint the prelude wired) must surface.
    const res = await parseSandboxOutput({
      ...base,
      exitCode: 137,
      readFile: io({
        "/data/stderr.txt":
          "HERMETIC_OOM_PREDICTED: [phase=doing something opaque] memory reached 88% of the cap. SWITCH STRATEGY: x.\n",
      }),
      skillFailureHints: GEO_HINTS,
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("SWITCH STRATEGY");
      expect(res.error).not.toContain("PARALLEL SCAN BUFFERS");
    }
  });

  it("recovers the OOM phase from the host-captured livePhase when files are blank (hard kill)", async () => {
    // A hard cgroup kill can reap the container init → every /data read is blank.
    // The host retained the last streamed phase; it must still route the retry.
    const res = await parseSandboxOutput({
      ...base,
      exitCode: 137,
      readFile: io({}), // nothing readable post-mortem
      livePhase: "counting occupied grid cells",
      skillFailureHints: GEO_HINTS,
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.errorKind).toBe("oom");
      expect(res.error).toContain("counting occupied grid cells");
      expect(res.error).toContain("span_m/200"); // GRID hint fired via livePhase
    }
  });

  it("skill failure hints beat the built-in phase router and are attributed in the diag", async () => {
    // A skill that knows its own failure mode supplies the remedy; the generic
    // GRID hint (which this phase would otherwise match) must not fire.
    const res = await parseSandboxOutput({
      ...base,
      exitCode: 137,
      readFile: io({}),
      livePhase: "counting cohort pivot cells",
      skillFailureHints: [
        {
          pattern: "cohort pivot",
          hint: "Aggregate the cohort matrix in DuckDB.",
          skill: "cohort-retention",
        },
      ],
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.errorKind).toBe("oom");
      expect(res.error).toContain("counting cohort pivot cells");
      expect(res.error).toContain("Aggregate the cohort matrix in DuckDB.");
      expect(res.error).not.toContain("span_m/200"); // built-in GRID hint suppressed
      expect(res.execDiag).toContain("hint=skill:cohort-retention");
    }
  });

  it("falls through to built-in phase hints when no skill hint matches (bad regex tolerated)", async () => {
    const res = await parseSandboxOutput({
      ...base,
      exitCode: 137,
      readFile: io({}),
      livePhase: "counting occupied grid cells",
      skillFailureHints: [
        { pattern: "([bad", hint: "never used", skill: "broken" },
        { pattern: "unrelated phase", hint: "never used", skill: "other" },
      ],
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      // No skill hint matched and the built-in router is domain-agnostic now →
      // the generic hard-kill guidance fires (with the phase preserved).
      expect(res.error).toContain("counting occupied grid cells");
      expect(res.error).toContain("HARD kernel OOM-kill");
      expect(res.error).not.toContain("never used");
    }
  });

  it("classifies a 137 with a VANISHED container as an external kill, never OOM", async () => {
    // Regression: the store sweeper `docker rm -f`ed live containers mid-scan
    // (split-brain containerOwner map) and the bare-137 heuristic diagnosed
    // every kill as a scan-buffer OOM — 4 retries chasing a phantom memory bug.
    // A genuine OOM leaves the container inspectable; gone = external kill.
    const res = await parseSandboxOutput({
      ...base,
      exitCode: 137,
      readFile: io({}),
      livePhase: "counting occupied grid cells", // must NOT trigger the GRID OOM hint
      containerGone: true,
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("removed externally");
      expect(res.error).toContain("NOT a memory");
      expect(res.errorKind).toBeUndefined(); // ordinary retryable error, not "oom"
      expect(res.error).not.toContain("PARALLEL SCAN BUFFERS");
    }
  });

  it("still classifies a 137 as OOM when the container SURVIVED the kill", async () => {
    const res = await parseSandboxOutput({
      ...base,
      exitCode: 137,
      readFile: io({ "/data/stderr.txt": "Killed" }),
      containerGone: false,
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.errorKind).toBe("oom");
  });

  it("classifies a missing package inside a user/skill module as user-config (non-retryable)", async () => {
    const stderr =
      'Traceback (most recent call last):\n  File "/data/script.py", line 3, in <module>\n' +
      '    from user_lib.metrics import net_revenue\n  File "/data/user_lib/metrics.py", line 2, in <module>\n' +
      "    import polars\nModuleNotFoundError: No module named 'polars'\n";
    const res = await parseSandboxOutput({
      ...base,
      exitCode: 1,
      readFile: io({ "/data/stderr.txt": stderr }),
    });
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.errorKind).toBe("user-config");
      expect(res.error).toContain("'polars'");
      expect(res.error).toContain("configuration issue");
    }
  });

  it("does NOT classify a ModuleNotFoundError in generated code itself as user-config", async () => {
    const stderr =
      'Traceback (most recent call last):\n  File "/data/script.py", line 3, in <module>\n' +
      "    import polars\nModuleNotFoundError: No module named 'polars'\n";
    const res = await parseSandboxOutput({
      ...base,
      exitCode: 1,
      readFile: io({ "/data/stderr.txt": stderr }),
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.errorKind).toBeUndefined(); // ordinary retryable code error
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
