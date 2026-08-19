/**
 * The SHARED, pure chart helpers (chart-theme.ts) that many components rely on
 * for axis/label/legend/color shaping. A bug in any of these silently corrupts
 * EVERY chart that uses it (the class the "missing alternate labels" bug came
 * from), yet they were untested — formatAxisNumber (7 charts), truncateLabel &
 * legendItemWidth (5 each), resolveColorMap.
 */
import { describe, it, expect } from "vitest";
import {
  formatAxisNumber,
  truncateLabel,
  legendItemWidth,
  resolveColorMap,
} from "@/components/theme/chart-theme";

describe("formatAxisNumber — abbreviate axis ticks", () => {
  it("abbreviates thousands and millions with the documented precision", () => {
    expect(formatAxisNumber(1500)).toBe("1.5k");
    expect(formatAxisNumber(10_000)).toBe("10k"); // ≥10k drops the decimal
    expect(formatAxisNumber(2_000_000)).toBe("2.0M");
    expect(formatAxisNumber(15_000_000)).toBe("15M"); // ≥10M drops the decimal
  });
  it("leaves small numbers (and small decimals) unabbreviated", () => {
    expect(formatAxisNumber(999)).toBe("999");
    expect(formatAxisNumber(0.6262)).toBe("0.6262");
  });
  it("carries the sign through the abbreviation", () => {
    expect(formatAxisNumber(-1500)).toBe("-1.5k");
  });
  it("accepts numeric strings and passes non-numbers through", () => {
    expect(formatAxisNumber("1500")).toBe("1.5k");
    expect(formatAxisNumber("N/A")).toBe("N/A");
  });
});

describe("truncateLabel", () => {
  it("leaves labels at or under the cap untouched", () => {
    expect(truncateLabel("abcde", 5)).toBe("abcde");
    expect(truncateLabel("short")).toBe("short");
  });
  it("ellipsizes longer labels to exactly `max` characters", () => {
    const out = truncateLabel("abcdefghijklmnop", 10);
    expect(out).toBe("abcdefghi…");
    expect(out).toHaveLength(10); // 9 chars + the ellipsis
  });
  it("coerces numbers to strings first", () => {
    expect(truncateLabel(12345, 3)).toBe("12…");
  });
});

describe("legendItemWidth — sized to the longest key, floored/capped", () => {
  it("floors at 100 for short or empty key sets", () => {
    expect(legendItemWidth([], 200)).toBe(100);
    expect(legendItemWidth(["a", "bc"], 200)).toBe(100); // 2*8+24=40 → floor 100
  });
  it("grows with the longest key up to maxWidth", () => {
    expect(legendItemWidth(["x".repeat(20)], 180)).toBe(180); // 20*8+24=184 → capped 180
    expect(legendItemWidth(["x".repeat(10)], 200)).toBe(104); // 10*8+24=104
  });
});

describe("resolveColorMap", () => {
  it("with no map, hands back the first N default colors", () => {
    const c = resolveColorMap(["a", "b", "c"]);
    expect(c).toHaveLength(3);
    c.forEach((x) => expect(typeof x).toBe("string"));
  });
  it("passes an explicit hex through and falls back for unmapped keys", () => {
    const c = resolveColorMap(["a", "b"], { a: "#ff0000" });
    expect(c[0]).toBe("#ff0000");
    // "b" has no mapping → a non-empty default color, never "".
    expect(c[1]).toBeTruthy();
    expect(c[1]).not.toBe("");
  });
});
