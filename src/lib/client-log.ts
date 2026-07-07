"use client";

/**
 * Fire-and-forget client→server logging. Mirrors to the browser console AND
 * forwards to /api/client-log so client-side diagnostics (mid-stream aborts,
 * unmount-while-streaming) land in the server logs the team debugs from.
 * `keepalive: true` lets the request survive a page unload — exactly when
 * the most interesting diagnostics fire. Never throws.
 */
export function logClient(
  level: "debug" | "info" | "warn" | "error",
  msg: string,
  meta?: Record<string, unknown>
): void {
  (console[level] ?? console.log)(msg, meta ?? "");
  try {
    void fetch("/api/client-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level, msg, meta }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // best-effort only
  }
}
