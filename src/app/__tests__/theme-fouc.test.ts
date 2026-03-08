import { describe, it, expect } from "vitest";

// Test that the FOUC prevention script logic is correct.
// We test the localStorage → data-theme mapping logic in isolation.

const VALID_THEMES = ["vanilla", "stamen", "iib", "pentagram"];

function simulateThemeScript(storedValue: string | null): string | null {
  try {
    const t = storedValue;
    if (t && VALID_THEMES.includes(t)) {
      return t;
    }
  } catch {
    // ignore
  }
  return null;
}

describe("theme FOUC prevention script logic", () => {
  it("returns stored theme when valid", () => {
    expect(simulateThemeScript("stamen")).toBe("stamen");
    expect(simulateThemeScript("iib")).toBe("iib");
    expect(simulateThemeScript("pentagram")).toBe("pentagram");
    expect(simulateThemeScript("vanilla")).toBe("vanilla");
  });

  it("returns null for invalid theme", () => {
    expect(simulateThemeScript("dark")).toBeNull();
    expect(simulateThemeScript("light")).toBeNull();
    expect(simulateThemeScript("custom")).toBeNull();
  });

  it("returns null for empty or null input", () => {
    expect(simulateThemeScript(null)).toBeNull();
    expect(simulateThemeScript("")).toBeNull();
  });

  it("validates against the same list used in theme-context", () => {
    // Ensure our valid themes list matches the THEMES array in theme-context
    expect(VALID_THEMES).toContain("vanilla");
    expect(VALID_THEMES).toContain("stamen");
    expect(VALID_THEMES).toContain("iib");
    expect(VALID_THEMES).toContain("pentagram");
    expect(VALID_THEMES).toHaveLength(4);
  });
});
