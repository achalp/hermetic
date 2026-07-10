import "server-only";
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
export async function withWakeLock<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  if (process.platform !== "darwin") return fn();

  let proc: ChildProcess | undefined;
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

  try {
    return await fn();
  } finally {
    if (proc) {
      proc.kill();
      logger.debug("Wake lock released", { reason });
    }
  }
}
