/**
 * S3 prefix enumeration (build log D21) — how a hive-partitioned / glob source is
 * turned into an explicit file list for the WASM tier.
 *
 * WHY THE HOST HAS TO DO THIS: DuckDB in the worker cannot glob. It only ever holds
 * token URLs to individual objects — there is no directory behind them — and its own
 * `s3://` globbing does not work here anyway (D18 measured `IO Error: No files found
 * that match the pattern`). So the host enumerates and hands DuckDB an explicit list.
 *
 * WHY THIS NEEDS NO NEW EGRESS POWER: an S3 listing is `GET /?list-type=2&prefix=…`
 * against the bucket host — an ordinary GET the Rust core already performs, against a
 * host that is already on the run's allowlist. No new verb, no new destination.
 *
 * The XML parsing below is PURE and separated from the network edge so it is fully
 * testable without a bucket (the fetch wrapper lives in remote-fetch.ts).
 */

/** One enumerated object. `key` is the full S3 key; `size` its byte length. */
export interface S3Object {
  key: string;
  size: number;
}

export interface S3ListPage {
  objects: S3Object[];
  /** Present when the listing is truncated — feed back as `continuation-token`. */
  nextToken?: string;
}

/**
 * Hard ceiling on how many objects one source may expand to. A hive tree with
 * millions of parts would otherwise mint millions of tokens and build an
 * unusable SQL list; failing loudly beats melting the run. Overture buildings —
 * the case that motivated this — is 512 files.
 */
export const MAX_ENUMERATED_FILES = 2000;

/** Decode the five XML entities S3 uses in keys. Keys may legitimately contain `&`.
 *  Exported for azure-list.ts: one decoder, one place the ordering below is right
 *  (a doubly-escaped `&amp;lt;` must not collapse to `<`), rather than two copies
 *  that can drift apart. */
export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&"); // last: an escaped &amp;lt; must not become <
}

/**
 * Parse one ListObjectsV2 response. Deliberately a narrow regex reader rather than
 * a full XML parser: the response shape is fixed, and we want no XML-parser
 * dependency (nor its entity/DTD surface) on a path fed by a remote server.
 *
 * `<Contents>` entries that are folder placeholders (trailing `/`, size 0) are
 * dropped — they are not readable parquet.
 */
export function parseS3ListXml(xml: string): S3ListPage {
  const objects: S3Object[] = [];
  const contents = xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? [];
  for (const block of contents) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
    if (key === undefined) continue;
    const decoded = unescapeXml(key);
    const sizeRaw = /<Size>(\d+)<\/Size>/.exec(block)?.[1];
    const size = sizeRaw ? Number(sizeRaw) : 0;
    if (decoded.endsWith("/")) continue; // folder placeholder
    objects.push({ key: decoded, size });
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  return truncated && next ? { objects, nextToken: unescapeXml(next) } : { objects };
}

/** Keep only the parquet objects — a release prefix also carries manifests/checksums. */
export function parquetObjectsOnly(objects: readonly S3Object[]): S3Object[] {
  return objects.filter((o) => /\.parquet$/i.test(o.key) && o.size > 0);
}

/**
 * Split an `s3://bucket/prefix` (or a glob like `s3://bucket/a/**‍/*.parquet`) into
 * the bucket and the LITERAL prefix to list — everything up to the first wildcard
 * segment, since S3 has no globbing of its own.
 */
export function splitS3Prefix(url: string): { bucket: string; prefix: string } | null {
  const rest = /^s3:\/\/(.+)$/i.exec(url)?.[1];
  if (!rest) return null;
  const slash = rest.indexOf("/");
  if (slash < 0) return { bucket: rest, prefix: "" };
  const bucket = rest.slice(0, slash);
  if (!bucket) return null;
  const keyPart = rest.slice(slash + 1);
  // Stop at the first segment containing a wildcard; S3 lists by literal prefix.
  const segments = keyPart.split("/");
  const literal: string[] = [];
  for (const seg of segments) {
    if (seg.includes("*") || seg.includes("?")) break;
    literal.push(seg);
  }
  let prefix = literal.join("/");
  // A folder source ("…/type=building") lists everything beneath it.
  if (prefix && !prefix.endsWith("/") && literal.length === segments.length) prefix += "/";
  else if (prefix && !prefix.endsWith("/")) prefix += "/";
  return { bucket, prefix };
}

/**
 * The ALIAS a file is registered under in DuckDB's virtual filesystem.
 *
 * This is load-bearing for correctness, not cosmetic: `hive_partitioning=true`
 * derives partition columns FROM THE PATH (`theme=buildings` → column `theme`).
 * Registering files under synthetic names would silently drop those columns, and a
 * query grouping on one would change meaning rather than fail. So the alias keeps
 * the key's path shape verbatim; DuckDB then parses partitions exactly as it would
 * have from the real URL.
 */
export function aliasForKey(key: string): string {
  return key;
}
