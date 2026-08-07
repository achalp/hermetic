/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useBrowserNav, type PageView } from "@/hooks/use-browser-nav";

function fire(view: PageView | null) {
  const ev = new PopStateEvent("popstate", { state: view ? { hermeticView: view } : null });
  window.dispatchEvent(ev);
}

describe("useBrowserNav — the state machine follows the browser stack", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("adopts the first view, pushes on forward transitions, and encodes the URL", () => {
    const onPopTo = vi.fn();
    const { rerender } = renderHook(
      ({ view }: { view: PageView }) => useBrowserNav({ view, onPopTo }),
      { initialProps: { view: "home" as PageView } }
    );
    expect(window.location.search).toBe("");
    rerender({ view: "data" });
    expect(window.location.search).toBe("?view=data");
    rerender({ view: "results" });
    expect(window.location.search).toBe("?view=results");
  });

  it("includes the restore id for saved results (URL-addressable)", () => {
    const { rerender } = renderHook(
      ({ view, restoreId }: { view: PageView; restoreId?: string | null }) =>
        useBrowserNav({ view, restoreId, onPopTo: () => {} }),
      { initialProps: { view: "home" as PageView, restoreId: null as string | null } }
    );
    rerender({ view: "results", restoreId: "abc-123" });
    expect(window.location.search).toBe("?view=results&restore=abc-123");
  });

  it("popstate walks the app back and does not re-push", async () => {
    const onPopTo = vi.fn();
    const { rerender } = renderHook(
      ({ view }: { view: PageView }) => useBrowserNav({ view, onPopTo }),
      { initialProps: { view: "home" as PageView } }
    );
    rerender({ view: "data" });
    rerender({ view: "results" });
    fire("data");
    expect(onPopTo).toHaveBeenCalledWith("data");
    fire(null); // oldest entry, no state → home
    expect(onPopTo).toHaveBeenCalledWith("home");
  });

  it("suspended transitions (analyzing overlays) are not recorded", () => {
    const { rerender } = renderHook(
      ({ view, suspended }: { view: PageView; suspended: boolean }) =>
        useBrowserNav({ view, suspended, onPopTo: () => {} }),
      { initialProps: { view: "data" as PageView, suspended: false } }
    );
    rerender({ view: "results", suspended: true });
    expect(window.location.search).toBe("?view=data");
    rerender({ view: "results", suspended: false });
    expect(window.location.search).toBe("?view=results");
  });
});
