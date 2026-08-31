/**
 * The STRICT same-host gate (spec §5.3, §8 — decided: no override in v1).
 *
 * "Same host" means the same STORAGE NAMESPACE, not the same URL string: a
 * manifest served from `https://bucket.s3.us-west-2.amazonaws.com/…` may
 * legitimately name its own objects as `s3://bucket/…`, and those are the same
 * place. So both sides normalize to a storage identity — (namespace, key) —
 * and equality is byte-equality on that pair:
 *
 *   s3://bucket/…                          → ("s3", "bucket")
 *   https://bucket.s3[.region].amazonaws…  → ("s3", "bucket")
 *   gs://bucket/…                          → ("gs", "bucket")
 *   https://bucket.storage.googleapis.com  → ("gs", "bucket")
 *   https://storage.googleapis.com/bucket/…→ ("gs", "bucket")   (path-style)
 *   anything else                          → (scheme, host)     (Azure lands here)
 *
 * Violating entries are DROPPED with a reason (surfaced in the entity browser as
 * "excluded: cross-host"); if ALL entries violate, the caller fails the connect
 * closed. This is defense in DEPTH: the egress proxy's resolve-and-reject remains
 * the boundary beneath it — this gate exists so a hostile manifest cannot even
 * *name* another origin, and so the run's egress allowlist stays one host wide.
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

/** Partition a manifest's entities into same-host (kept) and cross-host (excluded). */
export function enforceSameHost(manifest: DatasetManifest): SameHostResult {
  const kept: ManifestEntity[] = [];
  const excluded: ExcludedEntry[] = [];
  for (const e of manifest.entities) {
    if (sameStorageHost(e.url, manifest.manifestUrl)) kept.push(e);
    else {
      excluded.push({
        name: e.name,
        url: e.url,
        reason: "cross-host: entity is not on the manifest's own host (excluded by policy)",
      });
    }
  }
  return { kept, excluded };
}
