import { spawn, type ChildProcess } from "node:child_process";
import { logger } from "@/lib/logger";

/**
 * Hold a macOS power assertion for the duration of `fn`, so a long-running
 * sandbox execution is not interrupted by IDLE system sleep.
 *
 * Why this exists: the sandbox timeout is a Node `setTimeout`, which only
 * advances while the process is AWAKE. When the laptop idle-sleeps mid-run,
 * three things happen together — the container's DuckDB→S3 connections drop
 * (surfacing to the browser as "TypeError: network error"), the DuckDB scan
 * stalls and usually never recovers on wake, and the timeout timer freezes so
 * it eventually "times out" reporting far more wall-clock than its budget.
 * Every mid-run failure in this app's long remote-scan history has this
 * signature. `caffeinate -i` prevents idle sleep for as long as it runs; we
 * hold it only while a sandbox is executing and release it the instant the run
 * finishes, so it never keeps the machine awake longer than necessary.
 *
 * Best-effort and macOS-only: on other platforms, or if `caffeinate` is
 * missing, this is a transparent pass-through. It CANNOT prevent lid-close
 * sleep — nothing in userspace can — only idle sleep (walking away).
 */
// Ref-counted so overlapping holds share ONE caffeinate process: a whole run is
// wake-locked (covers the long LLM code-gen phase, where an idle-sleep would
// drop the client's stream — the observed failure), and the sandbox exec /
// warehouse query nest under it. The single process is spawned on the first
// acquire and killed on the last release, so nesting never keeps the machine
// awake longer than the outermost hold.
let refCount = 0;
let proc: ChildProcess | undefined;

/**
 * Acquire the wake lock; returns an idempotent release fn. Best-effort and
 * macOS-only (a transparent no-op elsewhere or if `caffeinate` is missing).
 * Prefer withWakeLock() when you have a function to wrap; use this directly for
 * a lifecycle that isn't a single call (e.g. a streaming run: acquire on start,
 * release in the finally).
 */
export function acquireWakeLock(reason: string): () => void {
  if (process.platform !== "darwin") return () => {};

  refCount++;
  if (refCount === 1) {
    try {
      // -i: prevent idle system sleep. -s: also prevent system sleep on AC.
      proc = spawn("caffeinate", ["-i", "-s"], { stdio: "ignore" });
      // A missing/failing caffeinate must not crash the run — degrade to no-op.
      proc.on("error", () => {
        proc = undefined;
      });
      logger.debug("Wake lock acquired", { reason });
    } catch {
      proc = undefined;
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0 && proc) {
      proc.kill();
      proc = undefined;
      logger.debug("Wake lock released", { reason });
    }
  };
}

/**
 * Hold the wake lock for the duration of `fn`. See the module note for why the
 * whole run — not just the sandbox exec — needs it.
 */
export async function withWakeLock<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  const release = acquireWakeLock(reason);
  try {
    return await fn();
  } finally {
    release();
  }
}
