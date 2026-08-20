// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useVizActions } from "@/hooks/use-viz-actions";

vi.mock("@/app/lib/api", () => ({
  loadViz: vi.fn(),
  refreshViz: vi.fn(),
  rerunViz: vi.fn(),
  saveViz: vi.fn(),
}));

import { loadViz, refreshViz, rerunViz, saveViz } from "@/app/lib/api";

const mLoad = loadViz as ReturnType<typeof vi.fn>;
const mRefresh = refreshViz as ReturnType<typeof vi.fn>;
const mRerun = rerunViz as ReturnType<typeof vi.fn>;
const mSave = saveViz as ReturnType<typeof vi.fn>;

const schema = { csv_id: "c", filename: "f.csv", row_count: 1, columns: [], sample_rows: [] };
const spec = { blocks: [] } as never;

type Args = Parameters<typeof useVizActions>[0];

function baseArgs(over: Partial<Args> = {}): Args {
  return {
    dispatch: vi.fn(),
    handleUpload: vi.fn(),
    loadWorkbookUpload: vi.fn(),
    warehouseId: null,
    loadedVizId: null,
    isAnalyzing: false,
    pendingRerunVizId: null,
    csvId: null,
    loadedSpec: null,
    currentQuestion: null,
    onHistoryId: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  mLoad.mockReset();
  mRefresh.mockReset();
  mRerun.mockReset();
  mSave.mockReset();
  window.scrollTo = vi.fn();
});

afterEach(() => cleanup());

describe("useVizActions", () => {
  it("exposes the action surface", () => {
    const { result } = renderHook(() => useVizActions(baseArgs()));
    expect(typeof result.current.handleLoadViz).toBe("function");
    expect(result.current.fileInputRef).toBeDefined();
  });

  it("handleLoadViz loads a plain (non-workbook) viz", async () => {
    mLoad.mockResolvedValue({
      csvId: "c1",
      schema,
      spec,
      artifacts: null,
      meta: { question: "Q", historyId: "h1" },
    });
    const args = baseArgs();
    const { result } = renderHook(() => useVizActions(args));
    await act(async () => {
      await result.current.handleLoadViz("viz-1");
    });
    expect(args.handleUpload).toHaveBeenCalledWith("c1", schema);
    expect(args.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "LOAD_VIZ_START" }));
    expect(args.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "LOAD_VIZ_SUCCESS", vizId: "viz-1" })
    );
    expect(args.onHistoryId).toHaveBeenCalledWith("h1");
  });

  it("handleLoadViz routes a workbook viz through loadWorkbookUpload", async () => {
    mLoad.mockResolvedValue({
      csvId: "c1",
      schema,
      spec,
      workbook: { filename: "b.xlsx", sheetInfo: [], relationships: [] },
      meta: { question: "Q" },
    });
    const args = baseArgs();
    const { result } = renderHook(() => useVizActions(args));
    await act(async () => {
      await result.current.handleLoadViz("viz-2");
    });
    expect(args.loadWorkbookUpload).toHaveBeenCalled();
    expect(args.onHistoryId).toHaveBeenCalledWith(null);
  });

  it("handleLoadViz dispatches LOAD_VIZ_ERROR on failure", async () => {
    mLoad.mockRejectedValue(new Error("gone"));
    const args = baseArgs();
    const { result } = renderHook(() => useVizActions(args));
    await act(async () => {
      await result.current.handleLoadViz("viz-x");
    });
    expect(args.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "LOAD_VIZ_ERROR" }));
  });

  it("handleRefreshViz streams the refresh stages and adopts the history id", async () => {
    mRefresh.mockResolvedValue({ csvId: "c2", schema, spec, artifacts: null, historyId: "h2" });
    const args = baseArgs({ warehouseId: "wh" });
    const { result } = renderHook(() => useVizActions(args));
    await act(async () => {
      await result.current.handleRefreshViz("viz-3");
    });
    expect(mRefresh).toHaveBeenCalledWith("viz-3", "wh");
    expect(args.handleUpload).toHaveBeenCalledWith("c2", schema);
    expect(args.onHistoryId).toHaveBeenCalledWith("h2");
  });

  it("toolbar handlers no-op without a loaded viz", () => {
    const args = baseArgs({ loadedVizId: null });
    const { result } = renderHook(() => useVizActions(args));
    act(() => result.current.handleRerunFromToolbar());
    act(() => result.current.handleRefreshFromToolbar());
    expect(mRefresh).not.toHaveBeenCalled();
  });

  it("auto-saves after an incompatible rerun completes", async () => {
    mSave.mockResolvedValue(undefined);
    const args = baseArgs({
      isAnalyzing: false,
      pendingRerunVizId: "viz-9",
      csvId: "c9",
      loadedSpec: spec,
      currentQuestion: "Q9",
    });
    renderHook(() => useVizActions(args));
    await act(async () => {});
    expect(mSave).toHaveBeenCalledWith("c9", spec, "Q9", "viz-9");
  });
});
