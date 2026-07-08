const CODE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface CachedCode {
  code: string;
  question: string;
  cachedAt: number;
}

const globalCache = globalThis as unknown as {
  __codeCache?: Map<string, CachedCode>;
};
if (!globalCache.__codeCache) {
  globalCache.__codeCache = new Map();
}
const cache = globalCache.__codeCache;

export function cacheGeneratedCode(csvId: string, code: string, question: string): void {
  cache.set(csvId, { code, question, cachedAt: Date.now() });
}

export function getCachedCode(csvId: string): { code: string; question: string } | undefined {
  const entry = cache.get(csvId);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > CODE_CACHE_TTL_MS) {
    cache.delete(csvId);
    return undefined;
  }
  return { code: entry.code, question: entry.question };
}

/** Active sweep (see lib/store-sweeper.ts) — expiry was lazy-read-only. */
export function sweepExpiredCodeCache(): number {
  const now = Date.now();
  let swept = 0;
  for (const [k, v] of cache) {
    if (now - v.cachedAt > CODE_CACHE_TTL_MS) {
      cache.delete(k);
      swept++;
    }
  }
  return swept;
}
