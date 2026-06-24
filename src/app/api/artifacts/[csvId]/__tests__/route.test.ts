import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Contract tests for /api/artifacts/[csvId]. The fast path reads the in-memory
 * cache; on a miss it must fall back to the persisted history entry (data lives
 * on disk under a UUID key) and re-warm the cache, instead of 404-ing — so the
 * artifacts trail never goes blank just because the 10-min cache aged out.
 */
vi.mock("@/lib/pipeline/artifacts-cache", () => ({
  getCachedArtifacts: vi.fn(),
  cacheArtifacts: vi.fn(),
}));
vi.mock("@/lib/history/storage", () => ({
  loadArtifactsByCsvId: vi.fn(),
}));

import { GET } from "@/app/api/artifacts/[csvId]/route";
import { getCachedArtifacts, cacheArtifacts } from "@/lib/pipeline/artifacts-cache";
import { loadArtifactsByCsvId } from "@/lib/history/storage";

const mockedGetCache = vi.mocked(getCachedArtifacts);
const mockedCacheArtifacts = vi.mocked(cacheArtifacts);
const mockedLoad = vi.mocked(loadArtifactsByCsvId);

const ARTIFACTS = {
  code: "print(1)",
  question: "q",
  results: {},
  chart_data: {},
  datasets: {},
  execution_ms: 1,
};

function req(csvId: string) {
  return GET(new Request("http://x"), { params: Promise.resolve({ csvId }) });
}

beforeEach(() => {
  mockedGetCache.mockReset();
  mockedCacheArtifacts.mockReset();
  mockedLoad.mockReset();
});

describe("GET /api/artifacts/[csvId]", () => {
  it("serves the in-memory cache when present (no history read)", async () => {
    mockedGetCache.mockReturnValue(ARTIFACTS);
    const res = await req("abc");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ARTIFACTS);
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  it("falls back to persisted history on cache miss and re-warms the cache", async () => {
    mockedGetCache.mockReturnValue(undefined);
    mockedLoad.mockResolvedValue(ARTIFACTS);
    const res = await req("abc");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ARTIFACTS);
    expect(mockedLoad).toHaveBeenCalledWith("abc");
    expect(mockedCacheArtifacts).toHaveBeenCalledWith("abc", ARTIFACTS);
  });

  it("404s only when neither cache nor history has it", async () => {
    mockedGetCache.mockReturnValue(undefined);
    mockedLoad.mockResolvedValue(undefined);
    const res = await req("abc");
    expect(res.status).toBe(404);
    expect(mockedCacheArtifacts).not.toHaveBeenCalled();
  });
});
