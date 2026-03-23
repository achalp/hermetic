/**
 * Force deck.gl v9 / luma.gl to use WebGL2 instead of WebGPU.
 * This module must be imported BEFORE any @deck.gl/* imports.
 *
 * Also patches a luma.gl v9.2 bug where ResizeObserver fires
 * before the WebGL device's `limits` property is initialized,
 * causing "Cannot read maxTextureDimension2D" errors.
 */
import { luma } from "@luma.gl/core";
import { webgl2Adapter } from "@luma.gl/webgl";

luma.registerAdapters([webgl2Adapter]);

// Suppress the ResizeObserver → maxTextureDimension2D race condition.
// This error is thrown asynchronously from a ResizeObserver callback
// inside luma.gl's CanvasContext, so it can't be caught by React
// error boundaries or DeckGL's onError. It's harmless — the next
// resize event succeeds once the device is fully initialized.
if (typeof window !== "undefined") {
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

  // Also catch unhandled promise rejections and error events from ResizeObserver
  window.addEventListener("error", (event) => {
    if (event.message?.includes("maxTextureDimension2D")) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  window.addEventListener("unhandledrejection", (event) => {
    if (
      event.reason &&
      typeof event.reason === "object" &&
      String(event.reason.message ?? event.reason).includes("maxTextureDimension2D")
    ) {
      event.preventDefault();
    }
  });
}
