import { describe, it, expect } from "vitest";
import {
  validateExecutionResult,
  formatSemanticVerdictForRetry,
} from "@/lib/pipeline/result-validator";
import type { SandboxExecutionResult } from "@/lib/contracts/execution";

function ok(): SandboxExecutionResult {
  return {
    success: true,
    results: { total: 100 },
    chart_data: { revenue_by_month: [{ month: "Jan", revenue: 10 }] },
    images: {},
    execution_ms: 50,
  };
}

function blank(): SandboxExecutionResult {
  return {
    success: true,
    results: {},
    chart_data: {},
    images: {},
    execution_ms: 50,
  };
}

describe("validateExecutionResult", () => {
  it("accepts a healthy result", () => {
    const v = validateExecutionResult(ok());
    expect(v.ok).toBe(true);
  });

  it("flags execution with no results and no chart data", () => {
    const v = validateExecutionResult(blank());
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toMatch(/no results or chart data/);
    expect(v.suggestedFix).toMatch(/results dict|chart_data dict/);
  });

  it("does NOT flag a single empty chart when real results exist (legit empty breakdown)", () => {
    const exec = ok(); // results: { total: 100 }
    exec.chart_data = { sales_by_quarter: [] };
    const v = validateExecutionResult(exec);
    expect(v.ok).toBe(true); // relaxed: an empty breakdown beside real data isn't degenerate
  });

  it("flags only when EVERY chart is empty AND no results were computed", () => {
    const exec = ok();
    exec.results = {};
    exec.chart_data = { a: [], b: [] };
    const v = validateExecutionResult(exec);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toMatch(/Every chart is empty/);
  });

  it("flags a single-result NaN scalar", () => {
    const exec = ok();
    exec.results = { mean_revenue: Number.NaN };
    exec.chart_data = {};
    const v = validateExecutionResult(exec);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toContain("mean_revenue");
    expect(v.reason).toMatch(/null\/NaN/);
  });

  it("flags single-result null and string 'nan' / 'None' / 'null'", () => {
    const cases: unknown[] = [null, "nan", "NaN", "None", "null", "  none  "];
    for (const value of cases) {
      const exec = ok();
      exec.results = { x: value };
      exec.chart_data = {};
      const v = validateExecutionResult(exec);
      expect(v.ok, `value=${String(value)} should be flagged`).toBe(false);
    }
  });

  it("does NOT flag a single null among many valid results", () => {
    const exec = ok();
    exec.results = { total: 100, segment_a: null, segment_b: 50 };
    exec.chart_data = {};
    const v = validateExecutionResult(exec);
    expect(v.ok).toBe(true); // null is legit "no data for one segment"
  });

  it("flags when EVERY result value is degenerate (multi-result case)", () => {
    const exec = ok();
    exec.results = { a: null, b: Number.NaN, c: "nan" };
    exec.chart_data = {};
    const v = validateExecutionResult(exec);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toMatch(/Every result value/);
  });

  it("flags a chart_data array (length > 1) where every numeric column is 0", () => {
    const exec = ok();
    exec.chart_data = {
      revenue_by_region: [
        { region: "N", revenue: 0 },
        { region: "S", revenue: 0 },
        { region: "E", revenue: 0 },
      ],
    };
    const v = validateExecutionResult(exec);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.reason).toMatch(/only zero values across 3 rows/);
    expect(v.reason).toContain("revenue_by_region");
  });

  it("does NOT flag a length-1 chart_data array of zeros (could be a baseline KPI)", () => {
    const exec = ok();
    exec.chart_data = { kpi: [{ name: "growth", value: 0 }] };
    const v = validateExecutionResult(exec);
    expect(v.ok).toBe(true);
  });

  it("does NOT flag a chart_data array with non-zero numeric values among zeros", () => {
    const exec = ok();
    exec.chart_data = {
      revenue: [
        { region: "N", revenue: 0 },
        { region: "S", revenue: 100 }, // non-zero — not degenerate
      ],
    };
    const v = validateExecutionResult(exec);
    expect(v.ok).toBe(true);
  });

  it("does NOT flag a chart_data array with only string columns (no numeric)", () => {
    const exec = ok();
    exec.chart_data = {
      labels: [{ name: "a" }, { name: "b" }, { name: "c" }],
    };
    const v = validateExecutionResult(exec);
    expect(v.ok).toBe(true);
  });

  it("prioritizes 'nothing at all' over more specific failures", () => {
    // If both results AND chart_data are empty, reason should be the
    // most fundamental message.
    const exec = ok();
    exec.results = {};
    exec.chart_data = {};
    const v = validateExecutionResult(exec);
    if (v.ok) throw new Error("expected fail");
    expect(v.reason).toMatch(/no results or chart data/);
  });

  it("treats null-/undefined-shaped exec.results and exec.chart_data defensively", () => {
    // Pretend a malformed sandbox response slipped through TS — should
    // not crash; should report the fundamental failure.
    const exec = {
      success: true,
      images: {},
      execution_ms: 50,
    } as unknown as SandboxExecutionResult;
    const v = validateExecutionResult(exec);
    expect(v.ok).toBe(false);
  });
});

describe("formatSemanticVerdictForRetry", () => {
  it("returns empty string on a healthy verdict", () => {
    expect(formatSemanticVerdictForRetry({ ok: true })).toBe("");
  });

  it("formats reason + suggested fix on a failure verdict", () => {
    const out = formatSemanticVerdictForRetry({
      ok: false,
      reason: "Result is null.",
      suggestedFix: "Check the filter.",
    });
    expect(out).toMatch(/Semantic failure/);
    expect(out).toContain("Result is null.");
    expect(out).toContain("Check the filter.");
  });
});

describe("findings collapse (menu run regression)", () => {
  const base = {
    results: { a: 1 },
    chart_data: { decade_averages: [{ decade: "1850s", median: 0.86 }] },
    datasets: {},
    execution_ms: 1,
  };
  const nullTrend = { direction: null, slope_per_period: 0, p_value: 1 };
  const flatDegenerate = { direction: "flat", slope_per_period: 0, p_value: 1 };

  it("counts 'flat' with slope 0 / p 1 as degenerate (run-23 regression)", () => {
    const exec = {
      ...base,
      findings: [
        { name: "t1", value: flatDegenerate },
        { name: "t2", value: flatDegenerate },
        { name: "t3", value: flatDegenerate },
        { name: "t4", value: flatDegenerate },
        { name: "ok", value: { direction: "rising", slope_per_period: 0.4, p_value: 0.001 } },
      ],
    } as never;
    const verdict = validateExecutionResult(exec);
    expect(verdict.ok).toBe(false);
  });

  it("fails validation when most findings are null/degenerate beside real charts", () => {
    const exec = {
      ...base,
      findings: [
        { name: "t1", value: nullTrend },
        { name: "t2", value: nullTrend },
        { name: "t3", value: { period: null, delta: null, direction: null } },
        { name: "t4", value: nullTrend },
        { name: "ok", value: { direction: "rising", slope_per_period: 0.4, p_value: 0.001 } },
      ],
    } as never;
    const verdict = validateExecutionResult(exec);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain("findings layer collapsed");
      expect(verdict.suggestedFix).toContain("ZEROS");
    }
  });

  it("passes when findings carry real values or too few to judge", () => {
    const healthy = {
      ...base,
      findings: [
        { name: "a", value: { direction: "rising", slope_per_period: 0.4, p_value: 0.01 } },
        { name: "b", value: { period: "2021-04", delta: 4.4, direction: "up" } },
        { name: "c", value: nullTrend },
        { name: "d", value: { pct_change: 200 } },
      ],
    } as never;
    expect(validateExecutionResult(healthy).ok).toBe(true);
    const few = { ...base, findings: [{ name: "a", value: nullTrend }] } as never;
    expect(validateExecutionResult(few).ok).toBe(true);
  });
});

describe("failed blocking checks fail validation (run-36: detector without sprinkler)", () => {
  const base = { results: { a: 1 }, chart_data: { c: [{ x: 1 }] }, datasets: {}, execution_ms: 1 };
  const blockingFail = {
    name: "scope_string_matches_observed_range",
    definition: "declared scope matches the observed year range",
    dtype: "check",
    tags: ["check", "blocking"],
    value: { passed: false, scope_declared_range: [1851, 2012], observed_range: [1970, 2012] },
  };

  it("fails with the check's own evidence in the retry message", () => {
    const verdict = validateExecutionResult({ ...base, findings: [blockingFail] } as never);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain("scope_string_matches_observed_range");
      expect(verdict.reason).toContain("1970");
      expect(verdict.suggestedFix).toContain("severity='caveat'");
    }
  });

  it("caveat-severity failures and passing blocking checks do not fail validation", () => {
    const caveat = { ...blockingFail, tags: ["check", "caveat"] };
    expect(validateExecutionResult({ ...base, findings: [caveat] } as never).ok).toBe(true);
    const passing = { ...blockingFail, value: { passed: true } };
    expect(validateExecutionResult({ ...base, findings: [passing] } as never).ok).toBe(true);
  });
});

describe("checks-only manifest fails validation (run-38 provenance regression)", () => {
  const base = { results: {}, chart_data: { c: [{ x: 1 }] }, datasets: {}, execution_ms: 1 };
  const check = (n: string) => ({
    name: n,
    definition: "a validation check over the data",
    dtype: "check",
    tags: ["check", "caveat"],
    value: { passed: true, n: 1 },
  });

  it("fails when results carries stats and the manifest is checks-only", () => {
    const exec = {
      ...base,
      results: {
        median_trend_p_value: 1.28e-11,
        avg_trend_slope: 0.2,
        max_trend_p_value: 0.023,
        peak_median_price: 38,
        peak_avg_price: 987,
        early_late_pct_change: 1280,
      },
      findings: [check("a"), check("b"), check("c")],
    } as never;
    const verdict = validateExecutionResult(exec);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain("no declared backing");
  });

  it("passes when findings back the stats", () => {
    const exec = {
      ...base,
      results: { median_trend_p_value: 1e-5, peak_median_price: 38 },
      findings: [
        check("a"),
        { name: "median_trend", definition: "d", dtype: "trend", value: { direction: "rising" } },
        { name: "peak_median", definition: "d", dtype: "superlative", value: { value: 38 } },
        { name: "avg_trend", definition: "d", dtype: "trend", value: { direction: "rising" } },
      ],
    } as never;
    expect(validateExecutionResult(exec).ok).toBe(true);
  });
});
