// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { useHomeComposer } from "@/hooks/use-home-composer";

afterEach(() => cleanup());

type Args = Parameters<typeof useHomeComposer>[0];

function makeWarehouse(over = {}) {
  return {
    savedConnections: [{ id: "wh1", label: "PG", name: "My PG", config: { type: "postgres" } }],
    connect: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as never;
}

function baseArgs(over: Partial<Args> = {}): Args {
  return {
    isState2: false,
    queryMode: "chart" as never,
    setQueryMode: vi.fn(),
    handleGuardedQuery: vi.fn().mockResolvedValue(undefined),
    uploadInputRef: createRef<HTMLInputElement>(),
    sandboxRuntime: "docker",
    setShowLocalBrowser: vi.fn(),
    setShowWarehouseForm: vi.fn(),
    warehouse: makeWarehouse(),
    handleSampleData: vi.fn().mockResolvedValue(undefined),
    reopenRecent: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe("useHomeComposer", () => {
  it("starts with an empty question and derives saved-connection items", () => {
    const { result } = renderHook(() => useHomeComposer(baseArgs()));
    expect(result.current.homeQuestion).toBe("");
    expect(result.current.savedConnectionItems).toEqual([
      expect.objectContaining({ id: "wh1", name: "My PG" }),
    ]);
  });

  it("setHomeQuestion updates the composed question", () => {
    const { result } = renderHook(() => useHomeComposer(baseArgs()));
    act(() => result.current.setHomeQuestion("what is the trend?"));
    expect(result.current.homeQuestion).toBe("what is the trend?");
  });

  it("composerNewWarehouse opens the warehouse form", () => {
    const args = baseArgs();
    const { result } = renderHook(() => useHomeComposer(args));
    act(() => result.current.composerNewWarehouse());
    expect(args.setShowWarehouseForm).toHaveBeenCalledWith(true);
  });

  it("composerLocalBrowse opens the browser under docker", () => {
    const args = baseArgs({ sandboxRuntime: "docker" });
    const { result } = renderHook(() => useHomeComposer(args));
    act(() => result.current.composerLocalBrowse());
    expect(args.setShowLocalBrowser).toHaveBeenCalledWith(true);
  });

  it("composerSavedConnect connects the matching saved warehouse", () => {
    const args = baseArgs();
    const { result } = renderHook(() => useHomeComposer(args));
    act(() => result.current.composerSavedConnect("wh1"));
    expect(args.warehouse.connect).toHaveBeenCalledWith({ type: "postgres" });
  });

  it("composerSample triggers the sample-data load", () => {
    const args = baseArgs();
    const { result } = renderHook(() => useHomeComposer(args));
    act(() => result.current.composerSample());
    expect(args.handleSampleData).toHaveBeenCalled();
  });

  it("runExample sets the mode, question, and loads the sample", () => {
    const args = baseArgs();
    const { result } = renderHook(() => useHomeComposer(args));
    act(() => result.current.runExample({ question: "Ex Q", mode: "table" as never } as never));
    expect(args.setQueryMode).toHaveBeenCalledWith("table");
    expect(result.current.homeQuestion).toBe("Ex Q");
    expect(args.handleSampleData).toHaveBeenCalled();
  });

  it("fires the armed question once the source becomes ready (isState2)", async () => {
    const handleGuardedQuery = vi.fn().mockResolvedValue(undefined);
    const setQueryMode = vi.fn();
    const args = baseArgs({ isState2: false, handleGuardedQuery, setQueryMode });
    const { result, rerender } = renderHook((a: Args) => useHomeComposer(a), {
      initialProps: args,
    });
    act(() => result.current.setHomeQuestion("armed question"));
    act(() => result.current.armFromComposer());
    // Not ready yet — nothing fired.
    expect(handleGuardedQuery).not.toHaveBeenCalled();
    // Source becomes ready.
    rerender(baseArgs({ isState2: true, handleGuardedQuery, setQueryMode }));
    await waitFor(() => expect(handleGuardedQuery).toHaveBeenCalledWith("armed question", "chart"));
  });
});
