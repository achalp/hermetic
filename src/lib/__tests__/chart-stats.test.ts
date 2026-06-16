import { describe, it, expect } from "vitest";
import { mean, stddev, quantile, invNormalCDF } from "@/lib/chart-stats";

describe("chart-stats", () => {
  it("mean of a sample", () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(mean([])).toBe(0);
  });

  it("sample standard deviation (n-1)", () => {
    // variance of [2,4,4,4,5,5,7,9] is 4 → sd 2 (classic example)
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 2);
    expect(stddev([5])).toBe(0);
  });

  it("quantile interpolates", () => {
    const s = [1, 2, 3, 4];
    expect(quantile(s, 0)).toBe(1);
    expect(quantile(s, 1)).toBe(4);
    expect(quantile(s, 0.5)).toBeCloseTo(2.5, 6);
  });

  it("invNormalCDF matches known probit values", () => {
    expect(invNormalCDF(0.5)).toBeCloseTo(0, 6);
    expect(invNormalCDF(0.975)).toBeCloseTo(1.959964, 4);
    expect(invNormalCDF(0.025)).toBeCloseTo(-1.959964, 4);
    expect(invNormalCDF(0.841344746)).toBeCloseTo(1, 4); // +1 sigma
    expect(invNormalCDF(0.99865)).toBeCloseTo(3, 3); // +3 sigma
  });

  it("invNormalCDF is antisymmetric and monotonic in the tails", () => {
    expect(invNormalCDF(0.001)).toBeCloseTo(-invNormalCDF(0.999), 4);
    expect(invNormalCDF(0.2)).toBeLessThan(invNormalCDF(0.8));
    expect(invNormalCDF(0)).toBe(-Infinity);
    expect(invNormalCDF(1)).toBe(Infinity);
  });
});
