import "server-only";
import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import { createHash } from "node:crypto";
import { join } from "path";
import { logger } from "@/lib/logger";

/**
 * Generic, source-agnostic schema cache.
 *
 * Every data source has a CHEAP "what is this / has it changed" probe and an
 * EXPENSIVE "understand it deeply" step (Parquet profiling ~27s, warehouse
 * introspection ~1-2 min). This caches the expensive artifact keyed by source
 * identity and gates reuse on a FINGERPRINT computed from the cheapest metadata
 * the storage layer exposes — a Parquet file listing, a warehouse's table
 * listing, an object ETag. Change is detected by fingerprint mismatch; nothing
 * is inferred from a URL naming convention.
 *
 * The elegant consequence: immutability is DETECTED, not assumed. An immutable
 * source produces a stable fingerprint and gets free caching as an emergent
 * property; a mutable one changes its fingerprint and re-extracts. No source is
 * special-cased.
 *
 * Persisted to disk (data/schema-cache/<hash>.json) so it survives a restart
 * and the in-memory stores' TTLs. Strictly best-effort: any cache failure
 * degrades to a normal extraction, never an error.
 */

const CACHE_DIR = join(process.cwd(), "data", "schema-cache");

export type CacheStatus = "hit" | "miss" | "stale" | "forced" | "bypass";

export interface SchemaCacheEntry<T> {
  /** The source identity this artifact was extracted for (pre-hash, for debugging). */
  sourceKey: string;
  /** Cheap probe value at extraction time; reuse requires a current match. */
  fingerprint: string;
  /** The expensive artifact (a CSVSchema, a WarehouseTableSchema[], …). */
  artifact: T;
  cachedAt: number;
}

/** Stable filename for a source key (sha256 → hex). */
function cacheFile(sourceKey: string): string {
  const hash = createHash("sha256").update(sourceKey).digest("hex");
  return join(CACHE_DIR, `${hash}.json`);
}

export async function readSchemaCache<T>(sourceKey: string): Promise<SchemaCacheEntry<T> | null> {
  try {
    const raw = await readFile(cacheFile(sourceKey), "utf-8");
    const entry = JSON.parse(raw) as SchemaCacheEntry<T>;
    // Guard against a corrupt / shape-drifted file.
    if (!entry || typeof entry.fingerprint !== "string" || entry.artifact === undefined)
      return null;
    return entry;
  } catch {
    // Absent or unreadable — a cache miss, not an error.
    return null;
  }
}

export async function writeSchemaCache<T>(
  sourceKey: string,
  fingerprint: string,
  artifact: T
): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const entry: SchemaCacheEntry<T> = { sourceKey, fingerprint, artifact, cachedAt: Date.now() };
    await writeFile(cacheFile(sourceKey), JSON.stringify(entry), "utf-8");
  } catch (err) {
    // Non-fatal: the extraction already succeeded, we just failed to cache it.
    logger.warn("schema-cache write failed (best-effort)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function deleteSchemaCache(sourceKey: string): Promise<void> {
  await unlink(cacheFile(sourceKey)).catch(() => {});
}

/**
 * Resolve an expensive schema artifact through the cache.
 *
 * - `force` (the "ignore cache / re-read" control): skip the lookup, extract
 *   fresh, and overwrite the cache (so subsequent calls hit).
 * - Otherwise: compute the cheap fingerprint; if it matches the cached entry,
 *   return the cached artifact (a `hit`); else extract, cache under the new
 *   fingerprint, and return.
 *
 * The fingerprint probe is best-effort: if it throws (a transient metadata
 * error), we do NOT serve a possibly-stale cache — we fall through to a fresh
 * extraction. Correctness over speed on the error path.
 */
export async function resolveWithCache<T>(opts: {
  sourceKey: string;
  fingerprint: () => Promise<string>;
  extract: () => Promise<T>;
  force?: boolean;
}): Promise<{ artifact: T; status: CacheStatus }> {
  const { sourceKey, fingerprint, extract, force } = opts;

  let fp: string | null = null;
  let wasStale = false;
  if (!force) {
    const cached = await readSchemaCache<T>(sourceKey);
    if (cached) {
      try {
        fp = await fingerprint();
      } catch (err) {
        // Probe failed — don't trust the cache; extract fresh (correctness
        // over speed), and mark the entry so the next run re-probes.
        logger.warn("schema-cache fingerprint probe failed; re-extracting", {
          sourceKey,
          error: err instanceof Error ? err.message : String(err),
        });
        const artifact = await extract();
        await writeSchemaCache(sourceKey, `probe-failed:${Date.now()}`, artifact);
        return { artifact, status: "miss" };
      }
      if (fp === cached.fingerprint) {
        logger.info("schema-cache hit", { sourceKey });
        return { artifact: cached.artifact, status: "hit" };
      }
      wasStale = true;
      logger.info("schema-cache stale (fingerprint changed) — re-extracting", { sourceKey });
    }
  }

  // Extract fresh. Compute the fingerprint too (cheap) so the fresh entry can be
  // matched next time — but never let a fingerprint failure sink a successful
  // extraction.
  const artifact = await extract();
  if (fp === null) {
    try {
      fp = await fingerprint();
    } catch {
      fp = `probe-failed:${Date.now()}`;
    }
  }
  await writeSchemaCache(sourceKey, fp, artifact);
  return { artifact, status: force ? "forced" : wasStale ? "stale" : "miss" };
}
