import type { CachedArtifacts } from "@/lib/contracts/investigation";
export type { CachedArtifacts };
import { isIdleExpired, touch, registerSweepable } from "@/lib/store-ttl";
import { stateNamespace } from "@/lib/state-store";

// SLIDING idle TTL (time since last read, not since it was cached) — every open
// of the artifacts panel / follow-up / recompose slides it forward, and an
// in-flight run pins it (see lib/store-ttl.ts). Was a 10-minute absolute window,
// which expired a result the user was still following up on.
const ARTIFACTS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour idle

interface CacheEntry extends CachedArtifacts {
  cachedAt: number;
  /** Sliding-idle-TTL bookkeeping (see lib/store-ttl.ts). */
  lastAccessedAt?: number;
  ownerRunId?: string;
}

const cache = stateNamespace<CacheEntry>("artifacts-cache");

export function cacheArtifacts(csvId: string, artifacts: CachedArtifacts): void {
  cache.set(csvId, { ...artifacts, cachedAt: Date.now() });
}

export function getCachedArtifacts(csvId: string): CachedArtifacts | undefined {
  const entry = cache.get(csvId);
  if (!entry) return undefined;
  const now = Date.now();
  if (isIdleExpired(entry, entry.cachedAt, ARTIFACTS_CACHE_TTL_MS, now)) {
    cache.delete(csvId);
    return undefined;
  }
  touch(entry, now);
  return {
    code: entry.code,
    question: entry.question,
    results: entry.results,
    chart_data: entry.chart_data,
    datasets: entry.datasets,
    execution_ms: entry.execution_ms,
    sql: entry.sql,
    // Explicit-field projection: findings was stored by cacheArtifacts but
    // STRIPPED here — the fourth appearance of the silent field-whitelist
    // loss class (declared-findings review E6). If you add a CachedArtifacts
    // field, it must appear HERE too.
    findings: entry.findings,
    investigation: entry.investigation,
  };
}

/** Active sweep (see lib/store-sweeper.ts) — expiry was lazy-read-only. */
export function sweepExpiredArtifacts(): number {
  const now = Date.now();
  let swept = 0;
  for (const [k, v] of cache) {
    if (isIdleExpired(v, v.cachedAt, ARTIFACTS_CACHE_TTL_MS, now)) {
      cache.delete(k);
      swept++;
    }
  }
  return swept;
}

// Sweep enrollment at the definition site (store-ttl registry) — a new
// store cannot be forgotten by the sweeper's roll call.
registerSweepable("artifacts", () => sweepExpiredArtifacts());
