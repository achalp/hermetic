// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useArtifacts } from "@/hooks/use-artifacts";

vi.mock("@/lib/api", () => ({
  getArtifacts: vi.fn(),
}));

import { getArtifacts } from "@/lib/api";
const mockGetArtifacts = getArtifacts as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockGetArtifacts.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("useArtifacts", () => {
  it("initializes hidden with no artifacts", () => {
    const { result } = renderHook(() => useArtifacts({ csvId: "csv-1" }));
    expect(result.current.showArtifacts).toBe(false);
    expect(result.current.artifacts).toBeNull();
    expect(result.current.artifactsLoading).toBe(false);
    expect(result.current.artifactsError).toBeNull();
  });

  it("toggles off when already showing", async () => {
    const { result } = renderHook(() => useArtifacts({ csvId: "csv-1" }));

    // Force show state
    act(() => {
      result.current.setShowArtifacts(true);
    });
    expect(result.current.showArtifacts).toBe(true);

    // Toggle off
    await act(async () => {
      await result.current.handleToggleArtifacts();
    });
    expect(result.current.showArtifacts).toBe(false);
    expect(mockGetArtifacts).not.toHaveBeenCalled();
  });

  it("fetches artifacts via api.getArtifacts on first toggle", async () => {
    const data = { code: "x=1", question: "Q", results: {}, execution_ms: 100 };
    mockGetArtifacts.mockResolvedValue(data);

    const { result } = renderHook(() => useArtifacts({ csvId: "csv-1" }));

    await act(async () => {
      await result.current.handleToggleArtifacts();
    });

    expect(mockGetArtifacts).toHaveBeenCalledWith("csv-1");
    expect(result.current.artifacts).toEqual(data);
    expect(result.current.showArtifacts).toBe(true);
    expect(result.current.artifactsLoading).toBe(false);
  });

  it("uses cached artifacts on subsequent toggle", async () => {
    const data = { code: "x=1", question: "Q", results: {}, execution_ms: 100 };
    mockGetArtifacts.mockResolvedValue(data);

    const { result } = renderHook(() => useArtifacts({ csvId: "csv-1" }));

    // First toggle: fetches
    await act(async () => {
      await result.current.handleToggleArtifacts();
    });
    expect(mockGetArtifacts).toHaveBeenCalledTimes(1);

    // Toggle off
    await act(async () => {
      await result.current.handleToggleArtifacts();
    });

    // Toggle on again: uses cache
    await act(async () => {
      await result.current.handleToggleArtifacts();
    });
    expect(mockGetArtifacts).toHaveBeenCalledTimes(1); // no additional fetch
    expect(result.current.showArtifacts).toBe(true);
  });

  it("sets error when fetch fails", async () => {
    mockGetArtifacts.mockRejectedValue(new Error("Not found"));

    const { result } = renderHook(() => useArtifacts({ csvId: "csv-1" }));

    await act(async () => {
      await result.current.handleToggleArtifacts();
    });

    expect(result.current.artifactsError).toBe(
      "Artifacts expired. Re-run the query or save the visualization first."
    );
    expect(result.current.showArtifacts).toBe(false);
  });

  it("is no-op when csvId is null", async () => {
    const { result } = renderHook(() => useArtifacts({ csvId: null }));

    await act(async () => {
      await result.current.handleToggleArtifacts();
    });

    expect(mockGetArtifacts).not.toHaveBeenCalled();
  });
});
