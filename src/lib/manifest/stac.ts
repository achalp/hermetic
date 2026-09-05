/**
 * STAC adapter (spec §4 revised, 2026-08-31): connect a SpatioTemporal Asset
 * Catalog — the format Overture ships its releases in — as a dataset manifest.
 *
 * STAC differs from the three v1 formats in one structural way: it is a TREE of
 * documents (catalog → child catalogs → collections → items), not one file. So
 * this is not a pure adapter — it is a small, capped TRAVERSAL that reuses the
 * connect flow's own fetcher (egress-core vetted, 8 MB cap per doc) and then
 * emits the same normalized `DatasetManifest` everything downstream consumes.
 *
 * Mapping (validated against the live Overture catalog, stac_version 1.1.0):
 *   Collection            → one entity
 *   collection id         → entity name (parent-catalog-qualified on collision)
 *   title + description   → entity description
 *   table:row_count       → rowCountHint
 *   table:columns         → columnDocs (name + description where present)
 *   first item's asset    → entity URL: the exact file when the collection has
 *                           ONE item; the asset's directory + `/*.parquet` when
 *                           it has many (Overture's layout: one directory per
 *                           type). Preferred asset: a host whose container we can
 *                           LIST — S3 first, then Azure Blob — else the first
 *                           parquet (fine for a single-file collection; a
 *                           multi-file one on an unlistable host is skipped).
 *
 * Bounds & trust:
 *   - traversal follows `child` links only on the SAME storage identity as the
 *     starting catalog (a catalog cannot chain into another origin's tree);
 *     asset URLs may be cross-host — that is the revised host policy;
 *   - `STAC_MAX_FETCHES` sub-documents, `STAC_MAX_DEPTH` levels, both fail
 *     SOFT (what was found so far is kept, truncation logged);
 *   - a root catalog with a `latest` field (Overture's release pointer)
 *     follows only the matching child — connecting the root means the latest
 *     release, not every release ever published.
 */
import type { DatasetManifest, ManifestEntity } from "@/lib/contracts/dataset-manifest";
import { sameStorageHost, storageIdentity } from "./same-host";
import {
  clampText,
  finalizeEntities,
  isParquetish,
  toCountHint,
  MAX_COLUMN_DOC_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_NAME_CHARS,
} from "./shared";
import { logger, errMessage } from "@/lib/logger";
import { splitAzurePrefix } from "@/lib/sandbox/azure-list";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Total sub-documents (catalogs + collections + items) one connect may fetch. */
export const STAC_MAX_FETCHES = 64;
/** Catalog nesting depth (root → release → theme → collection is 4). */
export const STAC_MAX_DEPTH = 4;

/** Cheap detection: run the traversal instead of the pure adapters? */
export function looksLikeStac(json: unknown): boolean {
  return (
    isRec(json) &&
    typeof json.stac_version === "string" &&
    (json.type === "Catalog" || json.type === "Collection")
  );
}

interface Link {
  rel: string;
  href: string;
}

function linksOf(json: Rec, baseUrl: string): Link[] {
  return asArray(json.links).flatMap((l) => {
    if (!isRec(l) || typeof l.rel !== "string" || typeof l.href !== "string") return [];
    try {
      return [{ rel: l.rel, href: new URL(l.href, baseUrl).toString() }];
    } catch {
      return [];
    }
  });
}

/** Pick the asset href for an item: prefer a host we can ENUMERATE — S3 first,
 *  then Azure Blob — else the first http(s) parquet asset. The order only decides
 *  anything for a multi-file collection, where an unlistable host means the
 *  entity is dropped entirely; for a one-item collection every parquet reads the
 *  same, so nothing is lost by preferring the listable mirror. */
export function pickItemAsset(item: unknown): string | null {
  if (!isRec(item) || !isRec(item.assets)) return null;
  const hrefs: string[] = [];
  for (const a of Object.values(item.assets)) {
    if (!isRec(a) || typeof a.href !== "string") continue;
    if (!/^https?:\/\//i.test(a.href)) continue;
    if (!isParquetish(a.href) && a.type !== "application/vnd.apache.parquet") continue;
    hrefs.push(a.href);
  }
  const s3 = hrefs.find((h) => storageIdentity(h)?.ns === "s3");
  const azure = hrefs.find((h) => splitAzurePrefix(h) !== null);
  return s3 ?? azure ?? hrefs[0] ?? null;
}

/** An https S3-vhost href as `s3://bucket/key` — the form enumeration and the
 *  vhost-only egress derivation both speak. Null for non-S3 hosts. */
export function toS3Url(href: string): string | null {
  const id = storageIdentity(href);
  if (id?.ns !== "s3") return null;
  try {
    const path = new URL(href).pathname.replace(/^\/+/, "");
    return `s3://${id.key}/${path}`;
  } catch {
    return null;
  }
}

/** Column docs from a `table:columns` array (STAC table extension). */
function stacColumnDocs(json: Rec): ManifestEntity["columnDocs"] {
  const docs = asArray(json["table:columns"]).flatMap((c) => {
    if (!isRec(c)) return [];
    const name = clampText(c.name, MAX_NAME_CHARS);
    const description = clampText(c.description, MAX_COLUMN_DOC_CHARS);
    return name && description ? [{ name, description }] : [];
  });
  return docs.length > 0 ? docs : undefined;
}

export interface StacResolveDeps {
  /** The connect flow's own vetted fetcher (fetchManifestText, creds bound). */
  fetchText(url: string): Promise<string>;
}

/**
 * Traverse a STAC catalog/collection into a normalized DatasetManifest.
 * `root` is the already-fetched starting document; `rootUrl` its URL.
 */
export async function resolveStacManifest(
  root: unknown,
  rootUrl: string,
  deps: StacResolveDeps
): Promise<DatasetManifest> {
  let fetches = 0;
  let truncated = false;
  const fetchJson = async (url: string): Promise<unknown | null> => {
    if (fetches >= STAC_MAX_FETCHES) {
      truncated = true;
      return null;
    }
    fetches++;
    try {
      return JSON.parse(await deps.fetchText(url)) as unknown;
    } catch (err) {
      logger.warn("STAC: sub-document unreadable, skipping", {
        url,
        error: errMessage(err),
      });
      return null;
    }
  };

  const entities: ManifestEntity[] = [];
  const usedNames = new Set<string>();
  const title = isRec(root) ? clampText(root.title ?? root.id, MAX_NAME_CHARS) : undefined;

  const addCollection = async (col: Rec, colUrl: string, parentId: string | undefined) => {
    const rawId = clampText(col.id, MAX_NAME_CHARS) ?? "collection";
    let name = rawId;
    if (usedNames.has(name) && parentId) name = `${parentId}-${rawId}`.slice(0, MAX_NAME_CHARS);
    if (usedNames.has(name)) return; // duplicate even qualified — drop, never overwrite
    const itemLinks = linksOf(col, colUrl).filter((l) => l.rel === "item");
    if (itemLinks.length === 0) return; // nothing to read
    // ONE item fetch tells us where the files live. Same-host as the catalog —
    // items are part of the catalog tree, not data.
    const firstItemUrl = itemLinks[0]!.href;
    if (!sameStorageHost(firstItemUrl, rootUrl)) return;
    const item = await fetchJson(firstItemUrl);
    const asset = pickItemAsset(item);
    if (!asset) return;
    // Many items ⇒ the collection is a directory of part files, read by
    // enumerating that directory. S3 enumeration speaks s3:// only, so a vhost
    // href converts to s3:// form; Azure Blob enumerates from the https URL as
    // written. A multi-file collection on a host we cannot LIST is still SKIPPED
    // — never truncated to its first file, because partial data produces
    // confidently wrong answers, the one failure mode worse than none.
    let url: string;
    if (itemLinks.length > 1) {
      const s3 = toS3Url(asset);
      const listable = s3 ?? (splitAzurePrefix(asset) ? asset : null);
      if (!listable) {
        logger.warn("STAC: multi-file collection on a host with no listing — skipped", {
          name,
          asset,
        });
        return;
      }
      url = `${listable.slice(0, listable.lastIndexOf("/"))}/*.parquet`;
    } else {
      url = asset;
    }
    usedNames.add(name);
    entities.push({
      name,
      url,
      description: clampText(
        [clampText(col.title, MAX_NAME_CHARS), clampText(col.description, MAX_DESCRIPTION_CHARS)]
          .filter(Boolean)
          .join(" — "),
        MAX_DESCRIPTION_CHARS
      ),
      rowCountHint: toCountHint(col["table:row_count"]),
      columnDocs: stacColumnDocs(col),
    });
  };

  const walk = async (json: unknown, url: string, depth: number): Promise<void> => {
    if (!isRec(json)) return;
    if (json.type === "Collection") {
      const parent = /\/([^/]+)\/[^/]+\/collection\.json$/i.exec(url)?.[1];
      await addCollection(json, url, parent);
      return;
    }
    if (json.type !== "Catalog") return;
    if (depth >= STAC_MAX_DEPTH) {
      truncated = true;
      return;
    }
    let children = linksOf(json, url).filter((l) => l.rel === "child");
    // Overture's release pointer: a root with `latest` follows only that child.
    const latest = typeof json.latest === "string" ? json.latest : undefined;
    if (latest) {
      const matching = children.filter((l) => l.href.includes(latest));
      if (matching.length > 0) children = matching;
    }
    const followable = children.filter((l) => sameStorageHost(l.href, rootUrl));
    if (followable.length < children.length) {
      logger.warn("STAC: skipped child links off the catalog's host", {
        skipped: children.length - followable.length,
      });
    }
    // Fetch children in CHUNKS: parallel within a chunk for latency, but each
    // chunk is fully WALKED (collection + its item probe) before the next is
    // fetched — so when the fetch budget runs out mid-tree, it ran out having
    // COMPLETED entities, not having spent everything on collection documents
    // whose item probes then all failed (caught by the cap test).
    const CHUNK = 8;
    for (let i = 0; i < followable.length; i += CHUNK) {
      const chunk = followable.slice(i, i + CHUNK);
      const docs = await Promise.all(chunk.map(async (l) => ({ l, doc: await fetchJson(l.href) })));
      for (const { l, doc } of docs) {
        if (doc !== null) await walk(doc, l.href, depth + 1);
      }
    }
  };

  await walk(root, rootUrl, 0);
  if (truncated) {
    logger.warn("STAC: traversal hit a cap — manifest may be partial", {
      fetches,
      entities: entities.length,
    });
  }
  return {
    manifestUrl: rootUrl,
    format: "stac",
    ...(title ? { title } : {}),
    entities: finalizeEntities(entities),
  };
}
