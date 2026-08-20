// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { useSchedulePopover } from "@/hooks/use-schedule-popover";

afterEach(() => {
  cleanup();
});

const fakeRect = { top: 1, left: 2, width: 3, height: 4 } as DOMRect;

function makeEvent() {
  return {
    currentTarget: { getBoundingClientRect: () => fakeRect },
  } as unknown as React.MouseEvent<HTMLButtonElement>;
}

describe("useSchedulePopover", () => {
  it("starts closed", () => {
    const { result } = renderHook(() =>
      useSchedulePopover({
        loadedVizId: null,
        lastSavedVizId: null,
        doSave: vi.fn(),
      })
    );
    expect(result.current.scheduleState).toEqual({ kind: "closed" });
  });

  it("opens directly with the loaded vizId", async () => {
    const doSave = vi.fn();
    const { result } = renderHook(() =>
      useSchedulePopover({ loadedVizId: "viz-1", lastSavedVizId: null, doSave })
    );
    await act(async () => {
      await result.current.handleScheduleClick(makeEvent());
    });
    expect(result.current.scheduleState).toEqual({
      kind: "open",
      vizId: "viz-1",
      anchorRect: fakeRect,
    });
    expect(doSave).not.toHaveBeenCalled();
  });

  it("falls back to lastSavedVizId when nothing loaded", async () => {
    const { result } = renderHook(() =>
      useSchedulePopover({ loadedVizId: null, lastSavedVizId: "viz-2", doSave: vi.fn() })
    );
    await act(async () => {
      await result.current.handleScheduleClick(makeEvent());
    });
    expect(result.current.scheduleState).toMatchObject({ kind: "open", vizId: "viz-2" });
  });

  it("auto-saves then opens with the new vizId", async () => {
    const doSave = vi.fn().mockResolvedValue("viz-new");
    const { result } = renderHook(() =>
      useSchedulePopover({ loadedVizId: null, lastSavedVizId: null, doSave })
    );
    await act(async () => {
      await result.current.handleScheduleClick(makeEvent());
    });
    expect(doSave).toHaveBeenCalledTimes(1);
    expect(result.current.scheduleState).toMatchObject({ kind: "open", vizId: "viz-new" });
  });

  it("returns to closed if the auto-save yields no vizId", async () => {
    const doSave = vi.fn().mockResolvedValue(null);
    const { result } = renderHook(() =>
      useSchedulePopover({ loadedVizId: null, lastSavedVizId: null, doSave })
    );
    await act(async () => {
      await result.current.handleScheduleClick(makeEvent());
    });
    expect(result.current.scheduleState).toEqual({ kind: "closed" });
  });

  it("setScheduleState can force-close", () => {
    const { result } = renderHook(() =>
      useSchedulePopover({ loadedVizId: "v", lastSavedVizId: null, doSave: vi.fn() })
    );
    act(() => result.current.setScheduleState({ kind: "auto-saving" }));
    expect(result.current.scheduleState).toEqual({ kind: "auto-saving" });
    act(() => result.current.setScheduleState({ kind: "closed" }));
    expect(result.current.scheduleState).toEqual({ kind: "closed" });
  });
});
