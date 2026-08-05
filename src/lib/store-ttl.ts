import { getRunId } from "@/lib/run-context";
import { stateBox, stateNamespace } from "@/lib/state-store";

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
/**
 * Liveness probe, INJECTED by the harness at boot (modularization M2-C4).
 * store-ttl sits below orchestration; importing run-control directly made
 * every store drag the run registry (audit §2.3). Unwired, no entry is
 * pinned — entries just expire on the sliding window.
 */
const livenessProbe = stateBox<((runId: string) => boolean) | null>(
  "store-ttl-liveness-probe",
  () => null
);

export function registerRunLivenessProbe(probe: (runId: string) => boolean): void {
  livenessProbe.set(probe);
}

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
  const probe = livenessProbe.get();
  if (entry.ownerRunId && probe && probe(entry.ownerRunId)) return false;
  return now - (entry.lastAccessedAt ?? base) > ttlMs;
}

/** Slide the idle window forward and pin the entry to the reading run (if any). */
export function touch(entry: TtlFields, now: number): void {
  entry.lastAccessedAt = now;
  const runId = getRunId();
  if (runId) entry.ownerRunId = runId;
}

// ── Sweep registry ──────────────────────────────────────────────────────────

/** Evicted-entry counts: a bare number logs under the registered name; a
 *  record logs each key as-is (for stores with multiple counters). */
export type SweepResult = number | Record<string, number>;
export type SweepFn = () => SweepResult | Promise<SweepResult>;

// StateStore-backed (like the liveness probe) so dev HMR re-registration
// replaces rather than duplicates an entry.
const sweepables = stateNamespace<SweepFn>("sweepables");

/**
 * Enroll a store's expired-entry sweep. Called at the store's DEFINITION site
 * (module scope), so a new store cannot be forgotten by a central roll call —
 * the sweeper iterates this registry (lib/store-sweeper.ts, which also
 * documents why a module-load list still exists there). Idempotent by name.
 */
export function registerSweepable(name: string, fn: SweepFn): void {
  sweepables.set(name, fn);
}

/** Run every registered sweep, flattening counts for the sweeper's log line. */
export async function runRegisteredSweeps(): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const [name, fn] of sweepables) {
    const result = await fn();
    if (typeof result === "number") counts[name] = result;
    else Object.assign(counts, result);
  }
  return counts;
}
