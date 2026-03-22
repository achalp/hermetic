const ARTIFACTS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export interface CachedArtifacts {
  code: string;
  question: string;
  results: Record<string, unknown>;
  chart_data: Record<string, unknown>;
  datasets: Record<string, Record<string, unknown>[]>;
  execution_ms: number;
  /** SQL query generated for warehouse data sources */
  sql?: string;
}

interface CacheEntry extends CachedArtifacts {
  cachedAt: number;
}

const globalCache = globalThis as unknown as {
  __artifactsCache?: Map<string, CacheEntry>;
};
if (!globalCache.__artifactsCache) {
  globalCache.__artifactsCache = new Map();
}
const cache = globalCache.__artifactsCache;

export function cacheArtifacts(csvId: string, artifacts: CachedArtifacts): void {
  cache.set(csvId, { ...artifacts, cachedAt: Date.now() });
}

export function getCachedArtifacts(csvId: string): CachedArtifacts | undefined {
  const entry = cache.get(csvId);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > ARTIFACTS_CACHE_TTL_MS) {
    cache.delete(csvId);
    return undefined;
  }
  return {
    code: entry.code,
    question: entry.question,
    results: entry.results,
    chart_data: entry.chart_data,
    datasets: entry.datasets,
    execution_ms: entry.execution_ms,
    sql: entry.sql,
  };
}
