/**
 * Manifest host policy (spec §5.3, §8 — REVISED 2026-08-31, author decision).
 *
 * v1 was a STRICT same-host gate: every entity had to share the manifest's own
 * storage identity, and cross-host entries were dropped. The author redefined
 * the rule: **the manifest's named hosts ARE the trust set** — "we are already
 * blindly trusting the manifest" (its host owner controls every entity URL, so
 * hostile data was always possible; cross-host merely adds more read-only GET
 * destinations, each still behind the egress core's resolve-and-reject, GET-only
 * verb, and byte caps). What this enables: real-world catalogs (Overture STAC)
 * whose index lives on one host and data on another.
 *
 * What still fails closed:
 *   - an entity URL that does not parse to a storage identity is EXCLUDED;
 *   - a manifest where NOTHING parses fails the connect;
 *   - the egress allowlist for any run is the union of the SELECTED entities'
 *     derived hosts — named-but-unselected hosts get no grant;
 *   - the proxy's resolve-and-reject remains the boundary beneath all of it.
 *
 * Storage identity normalization is unchanged (s3://bucket ≡ bucket vhost etc.)
 * and still used to compare hosts where equality matters (attach validation,
 * STAC traversal staying on the catalog's host).
 */
import type {
  DatasetManifest,
  ExcludedEntry,
  ManifestEntity,
} from "@/lib/contracts/dataset-manifest";

export interface StorageIdentity {
  ns: string;
  key: string;
}

const S3_VHOST = /^(.+)\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/i;
const GS_VHOST = /^(.+)\.storage\.googleapis\.com$/i;

export function storageIdentity(url: string): StorageIdentity | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const scheme = u.protocol.replace(/:$/, "").toLowerCase();
  const host = u.host.toLowerCase();

  if (scheme === "s3" || scheme === "s3a") return { ns: "s3", key: host };
  if (scheme === "gs" || scheme === "gcs") return { ns: "gs", key: host };

  if (scheme === "https" || scheme === "http") {
    const s3 = S3_VHOST.exec(host);
    if (s3) return { ns: "s3", key: s3[1]! };
    const gs = GS_VHOST.exec(host);
    if (gs) return { ns: "gs", key: gs[1]! };
    if (host === "storage.googleapis.com") {
      const bucket = u.pathname.split("/").filter(Boolean)[0];
      return bucket ? { ns: "gs", key: bucket.toLowerCase() } : null;
    }
    // http deliberately collapses into https: the SCHEME difference is not a
    // different storage namespace, and the egress core upgrades/validates anyway.
    return { ns: "https", key: host };
  }
  // Unknown scheme (az://, abfss://, …): namespace by scheme + authority. Exact
  // equality still works; nothing is ever ACCEPTED by failing to parse.
  return { ns: scheme, key: host };
}

export function sameStorageHost(a: string, b: string): boolean {
  const ia = storageIdentity(a);
  const ib = storageIdentity(b);
  return ia !== null && ib !== null && ia.ns === ib.ns && ia.key === ib.key;
}

export interface SameHostResult {
  kept: ManifestEntity[];
  excluded: ExcludedEntry[];
}

/**
 * Partition a manifest's entities into readable (kept) and unreadable
 * (excluded). Under the revised policy the manifest's own hosts are trusted, so
 * the ONLY exclusion is an entity URL that fails to parse to a storage
 * identity — those cannot be granted egress safely and are dropped with a
 * reason the entity browser can show.
 */
export function partitionManifestEntities(manifest: DatasetManifest): SameHostResult {
  const kept: ManifestEntity[] = [];
  const excluded: ExcludedEntry[] = [];
  for (const e of manifest.entities) {
    if (storageIdentity(e.url) !== null) kept.push(e);
    else {
      excluded.push({
        name: e.name,
        url: e.url,
        reason: "unreadable URL: no storage identity could be derived (excluded)",
      });
    }
  }
  return { kept, excluded };
}
