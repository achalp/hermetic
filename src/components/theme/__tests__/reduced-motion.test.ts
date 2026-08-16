// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useReducedMotion } from "@/components/theme/chart-theme";

/**
 * Guards the fix for nivo charts rendering blank/collapsed under
 * prefers-reduced-motion (a below-the-fold BarChart's bars stuck at the
 * react-spring from-state, height 0). The charts pass `animate={!useReducedMotion()}`,
 * so this hook must faithfully report the media-query state.
 */
function stubMatchMedia(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((q: string) => ({
      matches: q.includes("reduce") ? reduce : false,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("useReducedMotion", () => {
  it("is true when the OS prefers reduced motion", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(true);
  });

  it("is false when no reduced-motion preference is set", () => {
    stubMatchMedia(false);
    const { result } = renderHook(() => useReducedMotion());
    expect(result.current).toBe(false);
  });
});
