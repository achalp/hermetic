/**
 * Semantic result validator — pure function that inspects a successful
 * sandbox execution and returns a verdict on whether the result looks
 * degenerate (empty / NaN-only / all-zeros).
 *
 * Used by `runPipeline()` to catch the "code ran but the result is
 * useless" case that the current exception-only retry loop misses.
 * Semantic failures retry against the same budget as exception
 * failures; if the budget is exhausted the pipeline returns the
 * result with `degraded: true` rather than throwing.
 *
 * Conservative on purpose: we err on the side of NOT flagging things
 * that might be legitimate (e.g. single-row KPI results) — false
 * positives are worse than false negatives because they cost a retry
 * cycle. Order of checks below is "most fundamental first" so the
 * verdict's `reason` field cites the most informative failure.
 *
 * Out of scope (deferred):
 *
 * - Length-1 chart_data arrays: ambiguous (could be a KPI or could be
 *   a broken comparison). The implementation plan calls for inspecting
 *   chart-type hints from code-gen, but the chart type isn't actually
 *   decided until the UI-composition step downstream. Skipping for v1.
 */

import type { SandboxExecutionResult } from "@/lib/contracts/execution";

export type ValidationVerdict = { ok: true } | { ok: false; reason: string; suggestedFix: string };

/** True if `v` is JS NaN or one of the common stringified nullish markers. */
function isDegenerateScalar(v: unknown): boolean {
  if (typeof v === "number") return Number.isNaN(v);
  if (v === null || v === undefined) return true;
  if (typeof v === "string") {
    const trimmed = v.trim().toLowerCase();
    return trimmed === "nan" || trimmed === "none" || trimmed === "null";
  }
  return false;
}

/**
 * True if every numeric field across every row is exactly 0 (and there's
 * at least one numeric field). Excludes arrays where the only columns are
 * non-numeric (e.g. a pure list of labels) — those aren't degenerate, the
 * rendering layer just hasn't joined them with a metric yet.
 */
function isAllZeroRows(rows: unknown[]): boolean {
  if (rows.length === 0) return false;
  let sawNumeric = false;
  for (const row of rows) {
    if (!row || typeof row !== "object") return false;
    for (const v of Object.values(row as Record<string, unknown>)) {
      if (typeof v === "number") {
        sawNumeric = true;
        if (v !== 0) return false;
      }
    }
  }
  return sawNumeric;
}

export function validateExecutionResult(exec: SandboxExecutionResult): ValidationVerdict {
  const resultKeys = Object.keys(exec.results ?? {});
  const chartKeys = Object.keys(exec.chart_data ?? {});

  // Check #1 — nothing at all
  if (resultKeys.length === 0 && chartKeys.length === 0) {
    return {
      ok: false,
      reason: "Execution produced no results or chart data.",
      suggestedFix:
        "Make sure your code writes at least one entry into the results dict or chart_data dict before exiting.",
    };
  }

  // Check #2b — FINDINGS COLLAPSE (menu run, 2026-08-07): most declared
  // findings null-valued while charts carry real series. Observed cause: a
  // data-cleaning step converting legitimate ZEROS to null (a $0 median is
  // data; unpriced records are excluded at the RECORD level), gutting every
  // downstream fit — 10 of 12 findings null over an 18-element dashboard.
  // Rides the existing semantic retry so the run repairs instead of shipping.
  const findingEntries = Array.isArray(exec.findings) ? exec.findings : [];
  if (findingEntries.length >= 4 && chartKeys.length > 0) {
    const allNull = (val: unknown): boolean => {
      if (val === null || val === undefined) return true;
      if (typeof val !== "object" || Array.isArray(val)) return false;
      const rec = val as Record<string, unknown>;
      // slope exactly 0 with p exactly 1 is a regression that never ran —
      // "flat" beside them doesn't make the finding real (run-23: five such
      // trends narrated as flat over a series rising 243 -> 52,868).
      if (rec.slope_per_period === 0 && rec.p_value === 1) return true;
      const leaves = Object.values(rec);
      return leaves.length > 0 && leaves.every((x) => x === null || x === 0 || x === 1);
    };
    const nulled = findingEntries.filter((f) => allNull((f as { value?: unknown })?.value)).length;
    if (nulled / findingEntries.length > 0.6) {
      return {
        ok: false,
        reason: `${nulled} of ${findingEntries.length} declared findings are null/degenerate while chart_data holds real series — the findings layer collapsed.`,
        suggestedFix:
          "Almost always a cleaning bug upstream of the stat helpers: check whether ZEROS were converted to null/NaN (a $0 median is data — exclude unrecorded values at the RECORD level, not by nulling aggregates), and whether the series passed to finding_trend/step_change/current_state is the same non-null series the charts plot. Recompute findings from the populated series.",
      };
    }
  }

  // Check #3 — EVERY chart is an empty array and there are no results either.
  // A single empty chart alongside real results or a populated chart is legitimate
  // (that particular breakdown simply had no matching rows) — flagging it just
  // burns a retry. Only flag when the step produced nothing chartable AND no
  // scalar results: that's a genuinely degenerate output (usually a filter that
  // matched zero rows).
  const chartVals = chartKeys.map((k) => exec.chart_data[k]);
  const allChartsEmpty =
    chartVals.length > 0 && chartVals.every((v) => Array.isArray(v) && v.length === 0);
  if (allChartsEmpty && resultKeys.length === 0) {
    return {
      ok: false,
      reason: "Every chart is empty and no results were computed.",
      suggestedFix:
        "Your filters likely matched no rows — print `df[col].unique()` and widen them. If the empty result is legitimate, record the finding in results (e.g. results['no_X_found'] = True) instead of emitting empty chart arrays.",
    };
  }

  // Check #2 — null / NaN / "nan" / "None" scalar in results
  // Note: only flag if it's the ONLY result; a single null among many
  // valid keys is probably legitimate ("no data for this segment").
  if (resultKeys.length === 1) {
    const k = resultKeys[0];
    const v = exec.results[k];
    if (isDegenerateScalar(v)) {
      return {
        ok: false,
        reason: `Result "${k}" is null/NaN — the computation produced no usable value.`,
        suggestedFix:
          "Inspect the inputs to that calculation. Common causes: empty filter, missing column, type coercion failure (e.g. summing strings).",
      };
    }
  } else if (resultKeys.length > 1) {
    // Multi-result case: only flag if EVERY value is degenerate
    const allDegenerate = resultKeys.every((k) => isDegenerateScalar(exec.results[k]));
    if (allDegenerate) {
      return {
        ok: false,
        reason: "Every result value is null or NaN.",
        suggestedFix:
          "The computation chain produced no valid values. Check the data filter, then the aggregation, then the type coercions.",
      };
    }
  }

  // Check #5 — chart_data arrays where every numeric column is 0
  // Skip single-row arrays (could legitimately be a "zero baseline" KPI)
  // and only flag if length > 1, which strongly suggests a broken filter
  // or aggregation that lost the magnitudes.
  for (const k of chartKeys) {
    const v = exec.chart_data[k];
    if (Array.isArray(v) && v.length > 1 && isAllZeroRows(v)) {
      return {
        ok: false,
        reason: `Chart "${k}" has only zero values across ${v.length} rows.`,
        suggestedFix:
          "The aggregation likely lost magnitudes — check whether you're summing the right column and whether the filter narrowed to a single bucket.",
      };
    }
  }

  return { ok: true };
}

/**
 * Format a semantic verdict for inclusion in the retry prompt's
 * attempt-history list. The string is plugged in where exception
 * messages normally go.
 */
export function formatSemanticVerdictForRetry(verdict: ValidationVerdict): string {
  if (verdict.ok) return "";
  return `Semantic failure (no exception thrown but the result is degenerate):\n${verdict.reason}\nSuggested fix: ${verdict.suggestedFix}`;
}
