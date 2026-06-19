import { describe, it, expect } from "vitest";
import { pickTickValues, toNivoLineSeries } from "@/lib/chart-theme";

describe("pickTickValues", () => {
  it("returns undefined when everything fits", () => {
    const data = Array.from({ length: 5 }, (_, i) => ({ x: `m${i}` }));
    expect(pickTickValues(data, "x", 12)).toBeUndefined();
  });

  it("never emits a duplicate tick value (the Nivo duplicate-key crash)", () => {
    // Un-aggregated: 24 months × 12 rows each, x repeated — the exact shape
    // that produced 'two children with the same key, 2025-05'.
    const data: { month: string }[] = [];
    for (let m = 0; m < 24; m++) {
      const month = `2025-${String((m % 12) + 1).padStart(2, "0")}`;
      for (let r = 0; r < 12; r++) data.push({ month });
    }
    const ticks = pickTickValues(data, "month", 12)!;
    expect(ticks).toBeDefined();
    expect(new Set(ticks.map(String)).size).toBe(ticks.length); // all unique
  });

  it("always includes the last x value, uniquely", () => {
    const data = Array.from({ length: 40 }, (_, i) => ({ x: `p${i}` }));
    const ticks = pickTickValues(data, "x", 10)!;
    expect(ticks[ticks.length - 1]).toBe("p39");
    expect(new Set(ticks.map(String)).size).toBe(ticks.length);
  });
});

describe("toNivoLineSeries (regression context for the crash)", () => {
  it("collapses duplicate x within a series", () => {
    const data = [
      { month: "2025-05", revenue: 10 },
      { month: "2025-05", revenue: 20 },
      { month: "2025-06", revenue: 30 },
    ];
    const series = toNivoLineSeries(data, "month", ["revenue"]);
    expect(series).toHaveLength(1);
    const xs = series[0].data.map((p) => p.x);
    expect(new Set(xs.map(String)).size).toBe(xs.length);
  });
});
