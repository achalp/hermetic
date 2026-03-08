// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useSaveExport } from "@/hooks/use-save-export";
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function makeRefs() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spec = { root: "r", elements: {} } as any;
  return {
    csvId: "csv-1",
    currentSpecRef: { current: spec },
    currentQuestionRef: { current: "What are sales?" },
    dashboardRef: { current: document.createElement("div") },
    onSaved: vi.fn(),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("useSaveExport", () => {
  it("initializes with idle state", () => {
    const { result } = renderHook(() => useSaveExport(makeRefs()));
    expect(result.current.saving).toBe(false);
    expect(result.current.saveMessage).toBeNull();
    expect(result.current.exporting).toBeNull();
  });

  it("handleSave succeeds and calls onSaved", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ meta: {} }),
    });
    const refs = makeRefs();
    const { result } = renderHook(() => useSaveExport(refs));

    await act(async () => {
      await result.current.handleSave();
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/vizs/save",
      expect.objectContaining({
        method: "POST",
      })
    );
    expect(result.current.saveMessage).toBe("Saved!");
    expect(refs.onSaved).toHaveBeenCalled();
  });

  it("handleSave shows error on failure", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: "DB error" }),
    });
    const { result } = renderHook(() => useSaveExport(makeRefs()));

    await act(async () => {
      await result.current.handleSave();
    });

    expect(result.current.saveMessage).toBe("DB error");
    expect(result.current.saving).toBe(false);
  });

  it("handleSave is no-op when csvId is null", async () => {
    const refs = makeRefs();
    (refs as { csvId: string | null }).csvId = null;
    const { result } = renderHook(() => useSaveExport(refs));

    await act(async () => {
      await result.current.handleSave();
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("handleSave is no-op when spec is null", async () => {
    const refs = makeRefs();
    refs.currentSpecRef.current = null;
    const { result } = renderHook(() => useSaveExport(refs));

    await act(async () => {
      await result.current.handleSave();
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
