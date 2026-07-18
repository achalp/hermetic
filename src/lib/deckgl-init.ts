/**
 * Force deck.gl v9 / luma.gl to use WebGL2 instead of WebGPU.
 * This module must be imported BEFORE any @deck.gl/* imports.
 *
 * Also patches a luma.gl v9.2 bug where ResizeObserver fires
 * before the WebGL device's `limits` property is initialized,
 * causing "Cannot read maxTextureDimension2D" errors.
 */
// MUST be first: patches ResizeObserver before luma.gl constructs one.
import "@/lib/patch-resize-observer";
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";

luma.registerAdapters([webgl2Adapter]);

// Suppress the ResizeObserver → maxTextureDimension2D race condition.
// This error is thrown asynchronously from a ResizeObserver callback
// inside luma.gl's CanvasContext, so it can't be caught by React
// error boundaries or DeckGL's onError. It's harmless — the next
// resize event succeeds once the device is fully initialized.
// The window.onerror / capture-listener / console.error layers below exist
// ONLY to keep Next's DEV error overlay from popping on the benign luma.gl
// race — the tested source-level fix is patch-resize-observer. In production
// there is no overlay, and a session-wide console.error filter is the
// riskiest of the layers (it drops ANY error mentioning the string, from any
// code), so all three layers are dev-gated.
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  // ResizeObserver is patched in "@/lib/patch-resize-observer" (imported first)
  // to swallow the benign luma.gl race at its source. The listeners below are a
  // belt-and-suspenders backup for any path that still surfaces it.
  const origOnError = window.onerror;
  window.onerror = function (message, source, lineno, colno, error) {
    if (typeof message === "string" && message.includes("maxTextureDimension2D")) {
      return true; // suppress
    }
    if (origOnError) {
      return origOnError.call(this, message, source, lineno, colno, error);
    }
    return false;
  };

  const isBenign = (v: unknown): boolean =>
    String((v as { message?: string })?.message ?? v ?? "").includes("maxTextureDimension2D");

  // CAPTURE phase so we run BEFORE Next.js's dev-overlay listener (registered in
  // bubble phase, and earlier than this lazily-imported module). stopImmediate-
  // Propagation prevents the overlay listener from ever seeing this benign race.
  window.addEventListener(
    "error",
    (event) => {
      if (isBenign(event.error) || isBenign(event.message)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true
  );

  window.addEventListener(
    "unhandledrejection",
    (event) => {
      if (isBenign(event.reason)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true
  );

  // Next.js's dev error overlay surfaces errors via console.error, not just
  // window.onerror — so drop this benign race there too, or it pops the overlay
  // even though the map recovers on the next frame.
  const origConsoleError = console.error;
  console.error = function (...args: unknown[]) {
    const hit = args.some((a) =>
      String((a as { message?: string })?.message ?? a).includes("maxTextureDimension2D")
    );
    if (hit) return;
    origConsoleError.apply(this, args as []);
  };
}
