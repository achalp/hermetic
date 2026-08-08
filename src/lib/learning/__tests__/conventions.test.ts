import { describe, it, expect } from "vitest";
import { conventionCandidates } from "@/lib/learning/conventions";
import type { FindingEntry } from "@/lib/contracts/findings";

const check = (name: string, definition: string, value: Record<string, unknown>): FindingEntry => ({
  name,
  definition,
  dtype: "check",
  tags: ["check", "caveat"],
  value: { passed: true, ...value },
});

describe("conventionCandidates — interpretive, clean, measured (learning review)", () => {
  it("keeps interpretive checks with numeric evidence; drops mechanical ones", () => {
    const findings = [
      check("zero_price_semantics", "zero prices mean unrecorded; excluded at record level", {
        n_zero_years: 48,
      }),
      check("primary_metric_choice", "median leads: distribution skew justifies robust stats", {
        skew_avg: 7.65,
      }),
      // Mechanical: re-derived deterministically each run — never persists.
      check("year_continuity", "years are contiguous in the observed range", { gaps: 0 }),
      check("row_count_sanity", "row count matches source", { rows: 142 }),
    ];
    const names = conventionCandidates(findings, new Set()).map((f) => f.name);
    expect(names).toContain("zero_price_semantics");
    expect(names).toContain("primary_metric_choice");
    expect(names).not.toContain("row_count_sanity");
  });

  it("lint-flagged checks and evidence-free checks never qualify", () => {
    const flagged = check(
      "min_price_boolean_flag",
      "min_price is a boolean unrecorded-price flag",
      {
        is_boolean: false,
        zero_rows: 140,
      }
    );
    expect(conventionCandidates([flagged], new Set(["min_price_boolean_flag"]))).toHaveLength(0);
    const assertion = check("median_convention", "median is the primary metric", {});
    expect(conventionCandidates([assertion], new Set())).toHaveLength(0);
    const nonCheck: FindingEntry = {
      name: "median_trend",
      definition: "median convention trend over years",
      dtype: "trend",
      value: { direction: "rising", p_value: 0.001 },
    };
    expect(conventionCandidates([nonCheck], new Set())).toHaveLength(0);
  });
});
