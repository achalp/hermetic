/**
 * Regressions from the King County correlation dashboard. Each check is written
 * against the real numbers that produced the problem.
 */
import { describe, it, expect } from "vitest";
import {
  findSeriesOutliers,
  findFlatContradiction,
  findIdentityCorrelations,
  findInconsistentMagnitudes,
  buildDataSanityCaveats,
} from "@/lib/pipeline/data-sanity";

/** Homelessness rate 2015-2024: a ~60% collapse in 2021, then recovery. */
const homelessRows = [
  { year: "2015", homeless_rate: 470 },
  { year: "2016", homeless_rate: 495 },
  { year: "2017", homeless_rate: 540 },
  { year: "2018", homeless_rate: 510 },
  { year: "2019", homeless_rate: 505 },
  { year: "2020", homeless_rate: 520 },
  { year: "2021", homeless_rate: 230 },
  { year: "2022", homeless_rate: 590 },
  { year: "2023", homeless_rate: 620 },
  { year: "2024", homeless_rate: 730 },
];

describe("findSeriesOutliers", () => {
  it("catches the 2021 collapse the write-up never mentioned", () => {
    const found = findSeriesOutliers(homelessRows, "homeless_rate", "year");
    expect(found).toHaveLength(1);
    expect(found[0]!.at).toBe("2021");
    expect(found[0]!.deviation).toBeLessThan(-0.5);
  });

  it("does NOT flag the endpoint of a rising series", () => {
    // The first draft judged points against the series median and flagged 2024
    // (+42%) alongside 2021. In a trending series every recent point is far from
    // the median; only 2021 is a data problem.
    const found = findSeriesOutliers(homelessRows, "homeless_rate", "year");
    expect(found.map((f) => f.at)).toEqual(["2021"]);
  });

  it("does not mistake a STEP change for a bad reading", () => {
    // The level shifts and stays shifted: the neighbours disagree, so the middle
    // point is not a spike.
    const rows = [{ v: 10 }, { v: 10 }, { v: 11 }, { v: 50 }, { v: 52 }, { v: 51 }];
    expect(findSeriesOutliers(rows, "v")).toEqual([]);
  });

  it("catches a dropout between agreeing neighbours", () => {
    const rows = [{ v: 100 }, { v: 102 }, { v: 5 }, { v: 101 }, { v: 99 }];
    expect(findSeriesOutliers(rows, "v")).toHaveLength(1);
  });

  it("stays quiet on a well-behaved series", () => {
    const rows = [{ v: 10 }, { v: 11 }, { v: 12 }, { v: 11 }, { v: 13 }, { v: 12 }];
    expect(findSeriesOutliers(rows, "v")).toEqual([]);
  });

  it("says nothing about a series too short to have a typical value", () => {
    expect(findSeriesOutliers([{ v: 1 }, { v: 99 }], "v")).toEqual([]);
  });
});

describe("findFlatContradiction", () => {
  it("flags 'no significant trend' on a series that moved 55% end to end", () => {
    // The observed narrative: "trended flat (slope 10.8218, p = 0.0935)".
    const flat = findFlatContradiction(homelessRows, "homeless_rate", 0.0935);
    expect(flat).not.toBeNull();
    expect(flat!.move).toBeGreaterThan(0.5);
  });

  it("is silent when the slope IS significant — the narrative can just say so", () => {
    expect(findFlatContradiction(homelessRows, "homeless_rate", 0.006)).toBeNull();
  });

  it("is silent when a non-significant series genuinely went nowhere", () => {
    const rows = [{ v: 100 }, { v: 102 }, { v: 99 }, { v: 101 }];
    expect(findFlatContradiction(rows, "v", 0.6)).toBeNull();
  });
});

describe("findIdentityCorrelations", () => {
  it("catches the availability/vacancy tautology", () => {
    // The availability sub-index IS the rental vacancy rate, so the matrix
    // carried -1.00 and the dashboard presented it as a finding.
    const found = findIdentityCorrelations({
      corr_availability_d1_vs_vacancy_rate_pearson_r: -1.0,
      corr_hdi_composite_vs_homeless_rate_pearson_r: 0.0647,
    });
    expect(found).toEqual([{ a: "availability_d1", b: "vacancy_rate", r: -1.0 }]);
  });

  it("ignores ordinary strong correlations", () => {
    expect(findIdentityCorrelations({ corr_a_vs_b_pearson_r: 0.96 })).toEqual([]);
  });
});

describe("findInconsistentMagnitudes", () => {
  it("catches 0.2637 vs -0.2639 for what is the same measurement", () => {
    const results = {
      corr_availability_d1_vs_vacancy_rate_pearson_r: -1.0,
      corr_vacancy_rate_vs_homeless_rate_pearson_r: 0.2637,
      corr_availability_d1_vs_homeless_rate_pearson_r: -0.2639,
    };
    const bad = findInconsistentMagnitudes(results, findIdentityCorrelations(results));
    expect(bad).toHaveLength(1);
    expect(bad[0]).toMatchObject({ via: "homeless_rate", rA: -0.2639, rB: 0.2637 });
  });

  it("accepts equal magnitudes with opposite signs — that is expected", () => {
    const results = {
      corr_a_vs_b_pearson_r: -1.0,
      corr_a_vs_c_pearson_r: -0.5,
      corr_b_vs_c_pearson_r: 0.5,
    };
    expect(findInconsistentMagnitudes(results, findIdentityCorrelations(results))).toEqual([]);
  });
});

describe("buildDataSanityCaveats", () => {
  it("produces reader-facing caveats for the observed dashboard", () => {
    const caveats = buildDataSanityCaveats({
      results: {
        corr_availability_d1_vs_vacancy_rate_pearson_r: -1.0,
        corr_vacancy_rate_vs_homeless_rate_pearson_r: 0.2637,
        corr_availability_d1_vs_homeless_rate_pearson_r: -0.2639,
        homeless_rate_slope_p: 0.0935,
      },
      chartData: { annual_gap: homelessRows },
    });
    const all = caveats.join("\n");
    expect(all).toContain("same measurement under two names");
    expect(all).toContain("computed over different rows");
    expect(all).toContain("2021");
    expect(all).toContain("no statistically significant trend");
    // Phrased for a reader, not as identifiers.
    expect(all).not.toContain("_");
  });

  it("says nothing about clean data", () => {
    expect(
      buildDataSanityCaveats({
        results: { corr_a_vs_b_pearson_r: 0.4 },
        chartData: {
          s: [
            { x: "1", v: 10 },
            { x: "2", v: 11 },
            { x: "3", v: 12 },
          ],
        },
      })
    ).toEqual([]);
  });

  it("tolerates ragged inputs", () => {
    expect(() =>
      buildDataSanityCaveats({
        results: { corr_bad: "nope" } as Record<string, unknown>,
        chartData: { a: null, b: [], c: "no", d: [{ v: "text" }] } as Record<string, unknown>,
      })
    ).not.toThrow();
  });
});
