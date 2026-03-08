// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useArtifacts } from "@/hooks/use-artifacts";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
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
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fetches artifacts on first toggle", async () => {
    const data = { code: "x=1", question: "Q", results: {}, execution_ms: 100 };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(data),
    });

    const { result } = renderHook(() => useArtifacts({ csvId: "csv-1" }));

    await act(async () => {
      await result.current.handleToggleArtifacts();
    });

    expect(mockFetch).toHaveBeenCalledWith("/api/artifacts/csv-1");
    expect(result.current.artifacts).toEqual(data);
    expect(result.current.showArtifacts).toBe(true);
    expect(result.current.artifactsLoading).toBe(false);
  });

  it("uses cached artifacts on subsequent toggle", async () => {
    const data = { code: "x=1", question: "Q", results: {}, execution_ms: 100 };
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve(data),
    });

    const { result } = renderHook(() => useArtifacts({ csvId: "csv-1" }));

    // First toggle: fetches
    await act(async () => {
      await result.current.handleToggleArtifacts();
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Toggle off
    await act(async () => {
      await result.current.handleToggleArtifacts();
    });

    // Toggle on again: uses cache
    await act(async () => {
      await result.current.handleToggleArtifacts();
    });
    expect(mockFetch).toHaveBeenCalledTimes(1); // no additional fetch
    expect(result.current.showArtifacts).toBe(true);
  });

  it("sets error when fetch fails", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: "Not found" }),
    });

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

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
