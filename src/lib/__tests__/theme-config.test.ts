// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useStatCardTheme,
  useInsightTheme,
  useAnnotationTheme,
  THEME_CONFIGS,
} from "@/lib/theme-config";

vi.mock("@/lib/theme-context", () => ({
  useTheme: () => ({ theme: "vanilla", setTheme: vi.fn() }),
}));

describe("theme-config adapter hooks", () => {
  it("useStatCardTheme returns statCard slice", () => {
    const { result } = renderHook(() => useStatCardTheme());
    expect(result.current).toEqual(THEME_CONFIGS.vanilla.statCard);
  });

  it("useInsightTheme returns insight slice", () => {
    const { result } = renderHook(() => useInsightTheme());
    expect(result.current).toEqual(THEME_CONFIGS.vanilla.insight);
  });

  it("useAnnotationTheme returns annotation slice", () => {
    const { result } = renderHook(() => useAnnotationTheme());
    expect(result.current).toEqual(THEME_CONFIGS.vanilla.annotation);
  });
});
