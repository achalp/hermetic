/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useBrowserNav, type PageAddress } from "@/hooks/use-browser-nav";

function fire(view: string | null) {
  const ev = new PopStateEvent("popstate", { state: view ? { hermeticView: view } : null });
  window.dispatchEvent(ev);
}

const HOME: PageAddress = { view: "home" };

describe("useBrowserNav — every view is URL-addressed by its reconstruction keys", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("pushes fully-addressed URLs for data and saved results", () => {
    const { rerender } = renderHook(
      ({ address }: { address: PageAddress }) => useBrowserNav({ address, onPopTo: () => {} }),
      { initialProps: { address: HOME } as { address: PageAddress } }
    );
    rerender({ address: { view: "data", csvId: "csv-9" } });
    expect(window.location.search).toBe("?view=data&csv=csv-9");
    rerender({ address: { view: "results", entryId: "hist-1", csvId: "csv-9" } });
    expect(window.location.search).toBe("?restore=hist-1");
  });

  it("upgrades a transitional results URL IN PLACE when the history id arrives", () => {
    const { rerender } = renderHook(
      ({ address }: { address: PageAddress }) => useBrowserNav({ address, onPopTo: () => {} }),
      { initialProps: { address: HOME } as { address: PageAddress } }
    );
    rerender({ address: { view: "data", csvId: "csv-9" } });
    const depth = window.history.length;
    rerender({ address: { view: "results", csvId: "csv-9" } });
    expect(window.location.search).toBe("?view=results&csv=csv-9");
    // The save returns: same view, better address — replaceState, not push.
    rerender({ address: { view: "results", entryId: "hist-7", csvId: "csv-9" } });
    expect(window.location.search).toBe("?restore=hist-7");
    expect(window.history.length).toBe(depth + 1);
  });

  it("popstate walks the app back and does not re-push", () => {
    const onPopTo = vi.fn();
    const { rerender } = renderHook(
      ({ address }: { address: PageAddress }) => useBrowserNav({ address, onPopTo }),
      { initialProps: { address: HOME } as { address: PageAddress } }
    );
    rerender({ address: { view: "data", csvId: "c" } });
    rerender({ address: { view: "results", csvId: "c" } });
    fire("data");
    expect(onPopTo).toHaveBeenCalledWith("data");
    fire(null);
    expect(onPopTo).toHaveBeenCalledWith("home");
  });

  it("suspended transitions are not recorded; deep-link URLs are never clobbered", () => {
    window.history.replaceState(null, "", "/?restore=deep-1");
    const { rerender } = renderHook(
      ({ address, suspended }: { address: PageAddress; suspended: boolean }) =>
        useBrowserNav({ address, suspended, onPopTo: () => {} }),
      {
        initialProps: { address: HOME, suspended: false } as {
          address: PageAddress;
          suspended: boolean;
        },
      }
    );
    // First render must not clobber the pasted deep link.
    expect(window.location.search).toBe("?restore=deep-1");
    rerender({ address: { view: "results", csvId: "c" }, suspended: true });
    expect(window.location.search).toBe("?restore=deep-1");
  });
});
