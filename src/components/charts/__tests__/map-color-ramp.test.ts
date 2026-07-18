import { describe, it, expect } from "vitest";
import { BASEMAP_TILES, rampColor, numericRange } from "@/components/charts/map-color-ramp";

describe("map color ramp", () => {
  it("uses free, keyless Carto basemaps (dark default)", () => {
    expect(BASEMAP_TILES.dark).toContain("dark_all");
    expect(BASEMAP_TILES.light).toContain("light_all");
    expect(BASEMAP_TILES.dark).not.toMatch(/token|apikey|key=/i);
  });

  it("maps t=0 to the dark-blue low end and t=1 to the dark-red high end", () => {
    expect(rampColor(0)).toEqual([48, 18, 59]);
    expect(rampColor(1)).toEqual([122, 4, 3]);
  });

  it("clamps out-of-range and non-finite t", () => {
    expect(rampColor(-5)).toEqual([48, 18, 59]);
    expect(rampColor(2)).toEqual([122, 4, 3]);
    expect(rampColor(NaN)).toEqual([48, 18, 59]);
  });

  it("interpolates a mid value to a blend (not an endpoint)", () => {
    const mid = rampColor(0.5);
    expect(mid).not.toEqual([48, 18, 59]);
    expect(mid).not.toEqual([122, 4, 3]);
    mid.forEach((c) => expect(c).toBeGreaterThanOrEqual(0));
    mid.forEach((c) => expect(c).toBeLessThanOrEqual(255));
  });

  it("numericRange returns min/max, or null for missing/constant fields", () => {
    const data = [{ v: 10 }, { v: 30 }, { v: 20 }, { v: "x" }];
    expect(numericRange(data, "v")).toEqual({ min: 10, max: 30 });
    expect(numericRange(data, null)).toBeNull();
    expect(numericRange([{ v: 5 }, { v: 5 }], "v")).toBeNull(); // no spread
  });
});
