/**
 * The freshness fingerprint for a REMOTE Parquet source, computed on the host —
 * no Docker (build log D26).
 *
 * The Docker version runs DuckDB in a container and globs the object store. That
 * container was never doing anything the host cannot: `enumerateRemoteParquetFiles`
 * already performs the same S3 LIST through the Rust egress core (allowlist,
 * resolve-and-reject, IP pinning, no-redirect, byte cap), and it is already the
 * enumeration the wasm query path relies on. So this is composition, not a
 * reimplementation of the fingerprint idea.
 *
 * ── Same SEMANTICS, deliberately different FORMAT ──
 * Both fingerprints detect the same change (files added / removed / rewritten with
 * new names — how Spark/Delta/Iceberg/Hive writers emit data) and share the same
 * blind spot (a same-filename in-place byte overwrite; the manual refresh control
 * covers it). But the Docker digest is over DuckDB's `s3://bucket/key` strings and
 * this one is over listed keys, so the two would DISAGREE on an unchanged source.
 * The prefix (`s3list:` vs `files:`) makes them impossible to confuse: switching
 * runtimes reads as "changed" and re-extracts, which is correct, rather than
 * comparing two incomparable digests and calling a stale schema fresh.
 */
import { createHash } from "node:crypto";
import type { RemoteCreds } from "@/lib/contracts/storage-types";
import { enumerateRemoteParquetFiles, resolveRemoteHttpsFetch } from "@/lib/sandbox/remote-fetch";
import { fetchRemoteRange } from "@/lib/sandbox/egress-fetch";
import { splitS3Prefix } from "@/lib/sandbox/s3-list";

/**
 * Digest a listing into a fingerprint. Sorted so listing order — which S3 does not
 * promise across pages — cannot make an unchanged source look changed. Sizes are
 * included: a rewritten same-name file is invisible to a name-only digest, and here
 * it is nearly free to catch.
 */
export function fingerprintFromListing(objects: readonly { key: string; size: number }[]): string {
  const lines = objects
    .map((o) => `${o.key}:${o.size}`)
    .sort()
    .join("\n");
  const md5 = createHash("md5").update(lines).digest("hex");
  return `s3list:${objects.length}:${md5}`;
}

/** The fingerprint for a single remote object, from its size alone. */
export function fingerprintFromSize(totalBytes: number | null): string {
  return `size:${totalBytes ?? "unknown"}`;
}

/**
 * Fingerprint a remote Parquet source on the host. An `s3://` prefix is listed;
 * anything else (a single `https://` object) falls back to its size, which is all
 * a single object can offer without reading it.
 */
export async function computeRemoteParquetFingerprintHost(
  readUrl: string,
  creds?: RemoteCreds,
  opts?: { signal?: AbortSignal }
): Promise<string> {
  if (splitS3Prefix(readUrl)) {
    const { objects } = await enumerateRemoteParquetFiles(
      { remoteParquetUrl: readUrl, ...(creds ? { remoteCreds: creds } : {}) },
      { ...(opts?.signal ? { signal: opts.signal } : {}) }
    );
    return fingerprintFromListing(objects);
  }
  // Not an s3:// prefix: resolve the single object through the same plan the wasm
  // query path uses, then read ONE byte — the size comes back in Content-Range, so
  // no new verb and no meaningful transfer.
  const plan = await resolveRemoteHttpsFetch({
    remoteParquetUrl: readUrl,
    ...(creds ? { remoteCreds: creds } : {}),
  });
  if (!plan.ok) throw new Error(`Cannot fingerprint this remote source: ${plan.unsupported}`);
  const { total } = await fetchRemoteRange({
    url: plan.url,
    allowlist: plan.allowlist,
    range: "bytes=0-0",
    capBytes: 1024,
    ...(opts?.signal ? { signal: opts.signal } : {}),
  });
  return fingerprintFromSize(total);
}
