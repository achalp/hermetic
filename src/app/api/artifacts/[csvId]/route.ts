import { getCachedArtifacts, cacheArtifacts } from "@/lib/pipeline/artifacts-cache";
import { loadArtifactsByCsvId } from "@/lib/history/storage";

export async function GET(_request: Request, { params }: { params: Promise<{ csvId: string }> }) {
  const { csvId } = await params;

  // Fast path: the live in-memory cache (10-min TTL).
  let artifacts = getCachedArtifacts(csvId);

  // Fallback: the cache expired (or the dev server recompiled), but the run's
  // artifacts + trail are persisted in history. Serve them from disk and
  // re-warm the cache — the trail should never go blank just because an
  // in-memory cache aged out.
  if (!artifacts) {
    artifacts = await loadArtifactsByCsvId(csvId);
    if (artifacts) cacheArtifacts(csvId, artifacts);
  }

  if (!artifacts) {
    return new Response(JSON.stringify({ error: "Artifacts not found or expired" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify(artifacts), {
    headers: { "Content-Type": "application/json" },
  });
}
