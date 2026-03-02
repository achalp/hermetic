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

export function cacheGeneratedCode(
  csvId: string,
  code: string,
  question: string
): void {
  cache.set(csvId, { code, question, cachedAt: Date.now() });
}

export function getCachedCode(
  csvId: string
): { code: string; question: string } | undefined {
  const entry = cache.get(csvId);
  if (!entry) return undefined;
  if (Date.now() - entry.cachedAt > CODE_CACHE_TTL_MS) {
    cache.delete(csvId);
    return undefined;
  }
  return { code: entry.code, question: entry.question };
}
