import { describe, it, expect, vi, beforeEach } from "vitest";

// A minimal ResizeObserver stand-in (jsdom has none) whose `trigger()` invokes
// the callback the way the browser would fire a resize.
class FakeRO {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  trigger() {
    this.cb([], this as unknown as ResizeObserver);
  }
}

const BENIGN = "Cannot read properties of undefined (reading 'maxTextureDimension2D')";

describe("patch-resize-observer", () => {
  beforeEach(() => {
    vi.resetModules();
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeRO;
  });

  it("swallows the benign luma.gl race thrown inside a callback", async () => {
    await import("@/lib/patch-resize-observer");
    const Patched = (globalThis as unknown as { ResizeObserver: typeof FakeRO }).ResizeObserver;
    const ro = new Patched(() => {
      throw new TypeError(BENIGN);
    });
    expect(() => ro.trigger()).not.toThrow();
  });

  it("re-throws any other error untouched", async () => {
    await import("@/lib/patch-resize-observer");
    const Patched = (globalThis as unknown as { ResizeObserver: typeof FakeRO }).ResizeObserver;
    const ro = new Patched(() => {
      throw new Error("a real layout bug");
    });
    expect(() => ro.trigger()).toThrow("a real layout bug");
  });
});
