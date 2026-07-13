import "server-only";
import { getRunId } from "@/lib/run-context";
import { isRunActive } from "@/lib/pipeline/run-control";

/**
 * Shared expiry policy for the in-memory session stores (uploaded CSV, warehouse
 * connection, cached artifacts). Two rules, both aimed at never evicting data a
 * user is still working with:
 *
 *   1. SLIDING idle window — expiry is measured from the last read, not from
 *      creation. Callers `touch()` on every access, so an engaged session never
 *      expires mid-use.
 *   2. Active-run pin — an entry stamped with a run that is still in-flight is
 *      never evicted, however long that run takes. This is the piece a sliding
 *      window alone can't cover: a long analysis touches its store only at the
 *      start, so without the pin its data could expire while the run is still
 *      computing.
 *
 * Local/bind-mounted data (which lives on disk) opts out of expiry entirely and
 * doesn't go through here.
 */
export interface TtlFields {
  /** Last read (ms). Undefined until first touch → falls back to the base time. */
  lastAccessedAt?: number;
  /** The run that last read this entry; pins it while that run is active. */
  ownerRunId?: string;
}

/**
 * Whether `entry` should be evicted at `now`, given its creation time `base`
 * (createdAt / cachedAt) and idle window `ttlMs`. Pinned-by-active-run entries
 * never expire.
 */
export function isIdleExpired(entry: TtlFields, base: number, ttlMs: number, now: number): boolean {
  if (entry.ownerRunId && isRunActive(entry.ownerRunId)) return false;
  return now - (entry.lastAccessedAt ?? base) > ttlMs;
}

/** Slide the idle window forward and pin the entry to the reading run (if any). */
export function touch(entry: TtlFields, now: number): void {
  entry.lastAccessedAt = now;
  const runId = getRunId();
  if (runId) entry.ownerRunId = runId;
}
