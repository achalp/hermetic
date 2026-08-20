// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { useActiveRuns } from "@/hooks/use-active-runs";

vi.mock("@/app/lib/api", () => ({
  getActiveRuns: vi.fn(),
}));

import { getActiveRuns } from "@/app/lib/api";
const mockGetActiveRuns = getActiveRuns as ReturnType<typeof vi.fn>;

const run = (runId: string) => ({ runId, question: `q-${runId}` });

beforeEach(() => {
  mockGetActiveRuns.mockReset();
  mockGetActiveRuns.mockResolvedValue([run("a"), run("b")]);
});

afterEach(() => {
  cleanup();
});

describe("useActiveRuns", () => {
  it("fetches runs on mount", async () => {
    const { result } = renderHook(() => useActiveRuns());
    await waitFor(() => expect(result.current.runs).toHaveLength(2));
    expect(mockGetActiveRuns).toHaveBeenCalled();
    expect(result.current.runs.map((r) => r.runId)).toEqual(["a", "b"]);
  });

  it("does not fetch when disabled", async () => {
    const { result } = renderHook(() => useActiveRuns({ enabled: false }));
    // Give effects a tick.
    await act(async () => {});
    expect(mockGetActiveRuns).not.toHaveBeenCalled();
    expect(result.current.runs).toEqual([]);
  });

  it("dismiss filters a run out of the returned list", async () => {
    const { result } = renderHook(() => useActiveRuns());
    await waitFor(() => expect(result.current.runs).toHaveLength(2));
    act(() => result.current.dismiss("a"));
    expect(result.current.runs.map((r) => r.runId)).toEqual(["b"]);
  });

  it("refresh re-fetches", async () => {
    const { result } = renderHook(() => useActiveRuns());
    await waitFor(() => expect(result.current.runs).toHaveLength(2));
    mockGetActiveRuns.mockResolvedValue([run("c")]);
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.runs.map((r) => r.runId)).toEqual(["c"]));
  });
});
