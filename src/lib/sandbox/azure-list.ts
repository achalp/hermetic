/**
 * Azure Blob container enumeration — the Azure half of the multi-file remote
 * source path (mirrors s3-list.ts; build log D21).
 *
 * WHY IT EXISTS: a multi-file entity (a directory of part files) is read by
 * enumerating it HOST-SIDE and handing DuckDB an explicit file list — the worker
 * cannot glob. That only ever worked for S3, so a collection whose only parquet
 * lives on Azure Blob had to be dropped whole (manifest/stac.ts skipped it rather
 * than truncate to its first file, which would answer confidently from partial
 * data). This listing is what makes such a source readable instead of skipped.
 *
 * WHY IT NEEDS NO NEW EGRESS POWER: "List Blobs" is
 * `GET /<container>?restype=container&comp=list&prefix=…` on the account host —
 * an ordinary GET, to a host already on the run's allowlist, through the same
 * Rust core every other remote read goes through. No new verb, no new destination.
 *
 * ANONYMOUS ACCESS ONLY, ON PURPOSE. No `x-ms-version` header is sent, so the
 * service answers with its default version — which is what a container with
 * public read access serves. A PRIVATE container would need either a signed
 * `Authorization: SharedKey` (three correlated headers, one a signature over the
 * canonicalized request — the egress core carries a single static header and
 * cannot express it) or a SAS query, which the per-file read URLs built
 * downstream do not carry. Both fail LOUDLY at enumeration rather than reading
 * some blobs and silently missing others (see remote-fetch.ts).
 *
 * The XML parsing below is PURE and separated from the network edge, so it is
 * fully testable without a storage account (the fetch wrapper lives in
 * remote-fetch.ts).
 */
import { unescapeXml, type S3Object } from "./s3-list";

/**
 * One page of a List Blobs response. Objects carry the SAME `{key,size}` shape S3
 * enumeration returns — deliberately, so every downstream consumer (hive aliases,
 * footer prefetch, range tokens) is byte-identical for both clouds.
 */
export interface AzureListPage {
  objects: S3Object[];
  /** Present when the listing is paginated — feed back as `marker`. */
  nextMarker?: string;
}

/** What a source URL says about WHERE to list. `host` is kept verbatim so a
 *  sovereign-cloud suffix survives into the listing and per-blob read URLs. */
export interface AzurePrefix {
  /** Storage account — the first host label. */
  account: string;
  /** Account host as written (`acct.blob.core.windows.net`). */
  host: string;
  container: string;
  /** Literal blob-name prefix to list, container-relative. */
  prefix: string;
  /** Query string on the source URL, if any — NOT forwarded; see remote-fetch.ts. */
  search: string;
}

/**
 * Blob-service endpoints across the public and sovereign clouds. Narrow on
 * purpose: `dfs.core.windows.net` (ADLS Gen2) speaks a DIFFERENT API at a
 * different path shape, so it must NOT match and fall into a listing that would
 * 404 — an unmatched host fails closed at the caller instead.
 */
const AZURE_BLOB_HOST =
  /^([a-z0-9][a-z0-9-]*)\.blob\.core\.(?:windows\.net|chinacloudapi\.cn|usgovcloudapi\.net)$/i;

/**
 * Parse one List Blobs response. Like the S3 reader, a narrow regex rather than a
 * full XML parser: the shape is fixed, and we want no XML-parser dependency (nor
 * its entity/DTD surface) on a path fed by a remote server.
 */
export function parseListBlobs(xml: string): AzureListPage {
  const objects: S3Object[] = [];
  // `<Blob>`, not `<Blob` — `<BlobPrefix>` entries (returned when a delimiter is
  // used) are directory stubs, not readable objects, and must not be listed as files.
  const blocks = xml.match(/<Blob>[\s\S]*?<\/Blob>/g) ?? [];
  for (const block of blocks) {
    const name = /<Name>([\s\S]*?)<\/Name>/.exec(block)?.[1];
    if (name === undefined) continue;
    const decoded = unescapeXml(name);
    // `Content-Length` is the element name in every service version from the
    // default (2009-09-19, what an anonymous request gets) onward.
    const sizeRaw = /<Content-Length>\s*(\d+)\s*<\/Content-Length>/.exec(block)?.[1];
    const size = sizeRaw ? Number(sizeRaw) : 0;
    if (decoded.endsWith("/")) continue; // directory placeholder blob
    objects.push({ key: decoded, size });
  }
  // Azure has no IsTruncated: pagination continues iff NextMarker is NON-EMPTY.
  // The final page sends `<NextMarker />` (or an empty pair), which must not
  // drive another request — that would loop the listing forever.
  const raw = /<NextMarker>([\s\S]*?)<\/NextMarker>/.exec(xml)?.[1];
  const next = raw ? unescapeXml(raw).trim() : "";
  return next ? { objects, nextMarker: next } : { objects };
}

/** Percent-decode one path segment. The blob NAMES Azure returns are decoded, and
 *  the prefix we send is matched against them, so an encoded source URL has to be
 *  decoded here (per segment: a `%2F` must not become a path separator). */
function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg; // malformed escape: match literally rather than throw
  }
}

/**
 * Split an Azure Blob URL (`https://acct.blob.core.windows.net/container/a/*.parquet`)
 * into the account host, the container, and the LITERAL prefix to list —
 * everything up to the first wildcard segment, since List Blobs has no globbing
 * of its own. Exactly the shape splitS3Prefix produces for `s3://`.
 *
 * Null for any non-Azure-Blob URL, and for a wildcard in the CONTAINER segment:
 * a listing is scoped to ONE container, so a cross-container glob cannot be
 * answered — and must not be quietly narrowed to whichever container matched.
 */
export function splitAzurePrefix(url: string): AzurePrefix | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const account = AZURE_BLOB_HOST.exec(u.hostname)?.[1];
  if (!account) return null;

  const segments = u.pathname.split("/").slice(1).map(decodeSegment);
  const container = segments.shift();
  if (!container || container.includes("*") || container.includes("?")) return null;

  const literal: string[] = [];
  for (const seg of segments) {
    if (seg.includes("*") || seg.includes("?")) break;
    literal.push(seg);
  }
  let prefix = literal.join("/");
  // A folder source ("…/type=building") lists everything beneath it.
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  return {
    account: account.toLowerCase(),
    host: u.host.toLowerCase(),
    container,
    prefix,
    search: u.search.replace(/^\?/, ""),
  };
}
