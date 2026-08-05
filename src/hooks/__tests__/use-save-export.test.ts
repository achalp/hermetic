// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useSaveExport } from "@/hooks/use-save-export";

vi.mock("@/app/lib/api", () => ({
  saveViz: vi.fn(),
  exportInteractiveHtml: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  },
}));
// The HTML export downloads a blob via triggerDownload; the DOM-capture
// formats (pdf/docx/pptx) aren't exercised here, so mock the whole module.
vi.mock("@/lib/export-utils", () => ({
  downloadDashboardAsPdf: vi.fn(),
  downloadDashboardAsDocx: vi.fn(),
  downloadDashboardAsPptx: vi.fn(),
  triggerDownload: vi.fn(),
}));

import { saveViz, exportInteractiveHtml, ApiError } from "@/app/lib/api";
import { triggerDownload } from "@/lib/export-utils";
const mockSaveViz = saveViz as ReturnType<typeof vi.fn>;
const mockExportHtml = exportInteractiveHtml as ReturnType<typeof vi.fn>;

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
  mockExportHtml.mockReset();
  vi.mocked(triggerDownload).mockReset();
  // jsdom has no object-URL implementation.
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
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

  it("handleExportHtml posts the live spec, downloads the blob, and reports bundle+size", async () => {
    mockExportHtml.mockResolvedValue({
      blob: new Blob(["<!doctype html>"], { type: "text/html" }),
      filename: "what-are-sales.html",
      bundle: "standard",
      bytes: 3.2 * 1024 * 1024,
    });
    const refs = makeRefs();
    const { result } = renderHook(() => useSaveExport(refs));

    await act(async () => {
      await result.current.handleExportHtml();
    });

    // Spec goes AS-IS — internal-state stripping is the assembler's job.
    expect(mockExportHtml).toHaveBeenCalledWith(refs.currentSpecRef.current, "What are sales?");
    expect(triggerDownload).toHaveBeenCalledWith("blob:mock", "what-are-sales.html");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock");
    // Size honesty surfaced through the same status channel as Save.
    expect(result.current.saveMessage).toBe("HTML: standard bundle, 3.2 MB");
    expect(result.current.exporting).toBeNull();
  });

  it("handleExportHtml surfaces the server error message on failure", async () => {
    mockExportHtml.mockRejectedValue(
      new ApiError("Viewer export bundles not built. Run `pnpm mcp:build-viewer`, then retry.", 503)
    );
    const { result } = renderHook(() => useSaveExport(makeRefs()));

    await act(async () => {
      await result.current.handleExportHtml();
    });

    expect(triggerDownload).not.toHaveBeenCalled();
    expect(result.current.saveMessage).toContain("pnpm mcp:build-viewer");
    expect(result.current.exporting).toBeNull();
  });

  it("handleExportHtml is a no-op when there is no spec", async () => {
    const refs = makeRefs();
    refs.currentSpecRef.current = null;
    const { result } = renderHook(() => useSaveExport(refs));

    await act(async () => {
      await result.current.handleExportHtml();
    });

    expect(mockExportHtml).not.toHaveBeenCalled();
  });
});
