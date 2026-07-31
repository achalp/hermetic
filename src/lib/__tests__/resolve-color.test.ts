import { describe, it, expect } from "vitest";
import { resolveColor, resolveColors, CHART_COLORS, DEFAULT_CHART_COLORS } from "@/lib/chart-theme";

describe("resolveColor", () => {
  it("resolves named colors case-insensitively", () => {
    expect(resolveColor("Amber")).toBe(CHART_COLORS.amber);
  });

  it("passes hex codes through", () => {
    expect(resolveColor("#123abc")).toBe("#123abc");
  });

  // Regression: gauge specs with label-only ranges ({to, label}, no color)
  // crashed the whole response panel on nameOrHex.toLowerCase().
  it("returns a fallback for undefined/null/empty instead of throwing", () => {
    expect(resolveColor(undefined)).toBe(DEFAULT_CHART_COLORS[0]);
    expect(resolveColor(null)).toBe(DEFAULT_CHART_COLORS[0]);
    expect(resolveColor("")).toBe(DEFAULT_CHART_COLORS[0]);
    expect(resolveColor(undefined, "#fff")).toBe("#fff");
  });
});

describe("resolveColors", () => {
  it("gives null/undefined elements distinct palette fallbacks by index", () => {
    expect(resolveColors(["red", null, undefined])).toEqual([
      CHART_COLORS.red,
      DEFAULT_CHART_COLORS[1],
      DEFAULT_CHART_COLORS[2],
    ]);
  });
});
