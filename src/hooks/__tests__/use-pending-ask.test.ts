// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePendingAsk } from "@/hooks/use-pending-ask";

describe("usePendingAsk", () => {
  it("does not run before being armed, even when ready", () => {
    const run = vi.fn();
    renderHook(() => usePendingAsk(true, run));
    expect(run).not.toHaveBeenCalled();
  });

  it("runs once when armed and ready flips true", () => {
    const run = vi.fn();
    const { result, rerender } = renderHook(({ ready }) => usePendingAsk(ready, run), {
      initialProps: { ready: false },
    });

    act(() => result.current.arm({ question: "top products?", mode: "ask" }));
    expect(run).not.toHaveBeenCalled();
    expect(result.current.isArmed).toBe(true);

    rerender({ ready: true });
    expect(run).toHaveBeenCalledExactlyOnceWith("top products?", "ask");
    expect(result.current.isArmed).toBe(false);

    // Staying ready must not re-fire a consumed ask.
    rerender({ ready: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs immediately when armed while already ready", () => {
    const run = vi.fn();
    const { result } = renderHook(() => usePendingAsk(true, run));
    act(() => result.current.arm({ question: "why churn?", mode: "investigate" }));
    expect(run).toHaveBeenCalledExactlyOnceWith("why churn?", "investigate");
  });

  it("re-arming replaces the pending ask", () => {
    const run = vi.fn();
    const { result, rerender } = renderHook(({ ready }) => usePendingAsk(ready, run), {
      initialProps: { ready: false },
    });
    act(() => result.current.arm({ question: "first", mode: "ask" }));
    act(() => result.current.arm({ question: "second", mode: "investigate" }));
    rerender({ ready: true });
    expect(run).toHaveBeenCalledExactlyOnceWith("second", "investigate");
  });

  it("disarm cancels a pending ask", () => {
    const run = vi.fn();
    const { result, rerender } = renderHook(({ ready }) => usePendingAsk(ready, run), {
      initialProps: { ready: false },
    });
    act(() => result.current.arm({ question: "cancelled", mode: "ask" }));
    act(() => result.current.disarm());
    rerender({ ready: true });
    expect(run).not.toHaveBeenCalled();
    expect(result.current.isArmed).toBe(false);
  });
});
