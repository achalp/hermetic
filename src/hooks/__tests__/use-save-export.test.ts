// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useSaveExport } from "@/hooks/use-save-export";

vi.mock("@/lib/api", () => ({
  saveViz: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  },
}));

import { saveViz, ApiError } from "@/lib/api";
const mockSaveViz = saveViz as ReturnType<typeof vi.fn>;

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
  mockSaveViz.mockReset();
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

  it("handleSave calls api.saveViz and calls onSaved", async () => {
    mockSaveViz.mockResolvedValue({ meta: {} });
    const refs = makeRefs();
    const { result } = renderHook(() => useSaveExport(refs));

    await act(async () => {
      await result.current.handleSave();
    });

    expect(mockSaveViz).toHaveBeenCalledWith(
      "csv-1",
      refs.currentSpecRef.current,
      "What are sales?"
    );
    expect(result.current.saveMessage).toBe("Saved!");
    expect(refs.onSaved).toHaveBeenCalled();
  });

  it("handleSave shows ApiError message on failure", async () => {
    mockSaveViz.mockRejectedValue(new ApiError("DB error", 500));
    const { result } = renderHook(() => useSaveExport(makeRefs()));

    await act(async () => {
      await result.current.handleSave();
    });

    expect(result.current.saveMessage).toBe("DB error");
    expect(result.current.saving).toBe(false);
  });

  it("handleSave shows generic message on unknown error", async () => {
    mockSaveViz.mockRejectedValue(new Error("network"));
    const { result } = renderHook(() => useSaveExport(makeRefs()));

    await act(async () => {
      await result.current.handleSave();
    });

    expect(result.current.saveMessage).toBe("Save failed");
  });

  it("handleSave is no-op when csvId is null", async () => {
    const refs = makeRefs();
    (refs as { csvId: string | null }).csvId = null;
    const { result } = renderHook(() => useSaveExport(refs));

    await act(async () => {
      await result.current.handleSave();
    });

    expect(mockSaveViz).not.toHaveBeenCalled();
  });

  it("handleSave is no-op when spec is null", async () => {
    const refs = makeRefs();
    refs.currentSpecRef.current = null;
    const { result } = renderHook(() => useSaveExport(refs));

    await act(async () => {
      await result.current.handleSave();
    });

    expect(mockSaveViz).not.toHaveBeenCalled();
  });
});
