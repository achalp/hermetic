import { describe, it, expect } from "vitest";
import { formatStatNumber, formatStatValue } from "@/components/registry-primitives";

describe("formatStatNumber", () => {
  it("formats billions", () => {
    expect(formatStatNumber(1_500_000_000)).toBe("1.5B");
    expect(formatStatNumber(-2_000_000_000)).toBe("-2.0B");
  });

  it("formats millions", () => {
    expect(formatStatNumber(3_500_000)).toBe("3.5M");
    expect(formatStatNumber(1_000_000)).toBe("1.0M");
  });

  it("formats integers with locale", () => {
    expect(formatStatNumber(42_000)).toBe("42,000");
    expect(formatStatNumber(0)).toBe("0");
  });

  it("formats decimals", () => {
    expect(formatStatNumber(3.14159)).toBe("3.14");
  });

  it("applies prefix", () => {
    expect(formatStatNumber(1_500_000, "$")).toBe("$1.5M");
    expect(formatStatNumber(99, "€")).toBe("€99");
  });
});

describe("formatStatValue", () => {
  it("formats numbers", () => {
    expect(formatStatValue(1_000_000)).toBe("1.0M");
    expect(formatStatValue(42)).toBe("42");
  });

  it("formats currency strings", () => {
    expect(formatStatValue("$362,034")).toBe("$362,034");
    expect(formatStatValue("€1,500,000")).toBe("€1.5M");
  });

  it("preserves percent suffix", () => {
    expect(formatStatValue("85.5%")).toBe("85.50%");
  });

  it("returns non-numeric strings as-is", () => {
    expect(formatStatValue("N/A")).toBe("N/A");
    expect(formatStatValue("hello")).toBe("hello");
  });

  it("handles null/undefined", () => {
    expect(formatStatValue(null)).toBe("");
    expect(formatStatValue(undefined)).toBe("");
  });
});
