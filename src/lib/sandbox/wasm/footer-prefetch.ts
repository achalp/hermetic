/**
 * Host-side parallel footer prefetch (build log D21).
 *
 * THE PROBLEM: DuckDB in the worker reads by SYNCHRONOUS XHR, so its requests are
 * strictly sequential — it cannot overlap them. Before it can prune anything it must
 * read the parquet footer of every file: a HEAD plus ~2 range GETs each. Over the 512
 * files of the Overture buildings source that is ~1500 serial round trips, which at
 * ~60 ms each is minutes of pure latency before a single row is scanned.
 *
 * THE OBSERVATION: that serialization is a property of DUCKDB'S REQUEST PATTERN, not
 * of our fetch path. Nothing obliges the host to fetch only what it was just asked
 * for. The host knows the whole file list at token-mint time — before the worker has
 * even booted Pyodide — so it can warm the tail of every file IN PARALLEL while that
 * happens. DuckDB then still blocks on each request, unchanged and correct, but each
 * one resolves against a warm local cache instead of the network.
 *
 * WHY THIS DOES NOT WIDEN THE TRUST BOUNDARY: the host fetches from the SAME
 * pre-authorized URL set the tokens already permit — bytes the worker was already
 * entitled to ask for. No new destination, no new authority, same allowlist and cap.
 * If anything it NARROWS the residual channel from D20: the more of the traffic the
 * host schedules itself, the less the worker's choice of offsets shapes what leaves
 * the machine.
 */
import { fetchRemoteRange } from "@/lib/sandbox/egress-fetch";
import { logger } from "@/lib/logger";

/**
 * How much of each file's tail to warm. A parquet footer is the schema + per-row-group
 * statistics; 256 KiB covers it for the overwhelming majority of files (the Overture
 * parts measured ~620 KB of footer for a 525 MB file, and DuckDB reads it in two
 * steps — the 256 KiB tail probe first, which is what this serves).
 */
export const FOOTER_TAIL_BYTES = 256 * 1024;

/** Bound on concurrent upstream fetches — enough to hide latency, not a thundering herd. */
export const PREFETCH_CONCURRENCY = 16;

export interface PrefetchTarget {
  url: string;
  allowlist: string[];
  sizeBytes: number;
}

export interface PrefetchResult {
  warmed: number;
  failed: number;
  bytes: number;
}

/**
 * Warm the tail of every target, `PREFETCH_CONCURRENCY` at a time.
 *
 * Best-effort by design: a failure here must NEVER fail the run, because the worker
 * can always fetch the range itself — prefetch is a latency optimization, not a
 * correctness dependency. Failures are counted and logged, not thrown.
 *
 * `store` receives the warmed bytes; the range endpoint consults the same cache.
 */
export async function prefetchFooters(
  targets: readonly PrefetchTarget[],
  store: (url: string, start: number, body: Buffer) => void,
  opts?: { signal?: AbortSignal; binPath?: string; concurrency?: number }
): Promise<PrefetchResult> {
  const result: PrefetchResult = { warmed: 0, failed: 0, bytes: 0 };
  if (targets.length === 0) return result;

  const limit = Math.max(1, opts?.concurrency ?? PREFETCH_CONCURRENCY);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= targets.length) return;
      if (opts?.signal?.aborted) return;
      const t = targets[i];
      // Tail range: the last FOOTER_TAIL_BYTES of the object (or all of a small one).
      const start = Math.max(0, t.sizeBytes - FOOTER_TAIL_BYTES);
      const end = Math.max(0, t.sizeBytes - 1);
      if (end < start) continue;
      try {
        const { body } = await fetchRemoteRange({
          url: t.url,
          allowlist: t.allowlist,
          range: `bytes=${start}-${end}`,
          capBytes: FOOTER_TAIL_BYTES * 2,
          ...(opts?.binPath ? { binPath: opts.binPath } : {}),
          ...(opts?.signal ? { signal: opts.signal } : {}),
        });
        store(t.url, start, body);
        result.warmed++;
        result.bytes += body.length;
      } catch {
        // Best-effort: the worker will fetch it on demand.
        result.failed++;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, targets.length) }, worker));
  logger.info("WASM remote: footer prefetch complete", {
    files: targets.length,
    warmed: result.warmed,
    failed: result.failed,
    mb: Math.round(result.bytes / 1e6),
  });
  return result;
}
