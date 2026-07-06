/**
 * Wrap ResizeObserver so luma.gl's benign "maxTextureDimension2D" race — thrown
 * synchronously INSIDE a ResizeObserver callback when the WebGL device's limits
 * aren't populated yet — is swallowed at the source. Otherwise it surfaces as an
 * uncaught error that Next.js's dev overlay grabs before any window listener can.
 * Everything else re-throws untouched; the map recovers on the next resize.
 *
 * Imported FIRST (before any @luma.gl/@deck.gl module) so the patched
 * ResizeObserver is the one those libraries construct.
 */
if (typeof globalThis !== "undefined" && typeof ResizeObserver !== "undefined") {
  const Orig = ResizeObserver;
  const isBenign = (e: unknown): boolean =>
    String((e as { message?: string })?.message ?? e ?? "").includes("maxTextureDimension2D");

  class PatchedResizeObserver extends Orig {
    constructor(cb: ResizeObserverCallback) {
      super((entries, observer) => {
        try {
          cb(entries, observer);
        } catch (e) {
          if (isBenign(e)) return;
          throw e;
        }
      });
    }
  }

  const g = globalThis as unknown as { ResizeObserver: typeof ResizeObserver };
  g.ResizeObserver = PatchedResizeObserver;
}
