/**
 * Resolve a stored remote source into a fetchable HTTPS URL + allowlist for the
 * host-side WASM remote path (build log D13). `s3://` becomes a virtual-hosted HTTPS
 * URL (pre-signed with the user's keys when present — keys stay host-side); `https://`
 * passes through. The allowlist is the vetted host derivation (deriveAllowedEgressHosts
 * — SSRF-guarded), so `egress-fetch` fetches through the §6a core.
 *
 * Unsupported shapes fail EXPLICITLY (never a silent wrong fetch): folder globs,
 * hive-partitioned trees (need listing/range reads, not a single-file GET), `gs://`
 * without an S3-interop endpoint, and non-http(s) endpoints. The caller routes those
 * to Docker.
 */
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { unlink, mkdir } from "node:fs/promises";
import { deriveAllowedEgressHosts } from "./egress";
import { presignS3GetUrl } from "./s3-presign";
import { materializeRemoteToFile, fetchRemoteRange } from "./egress-fetch";
import {
  parseS3ListXml,
  parquetObjectsOnly,
  splitS3Prefix,
  MAX_ENUMERATED_FILES,
  type S3Object,
} from "./s3-list";
import { parseListBlobs, splitAzurePrefix, type AzurePrefix } from "./azure-list";
import { parquetToCsv } from "./wasm/parquet-convert";
import type { RemoteCreds } from "@/lib/contracts/storage-types";

export interface StoredRemote {
  remoteParquetUrl?: string;
  remoteCreds?: RemoteCreds;
  isHivePartitioned?: boolean;
}

export type RemoteFetchPlan =
  { ok: true; url: string; allowlist: string[] } | { ok: false; unsupported: string };

/** Build the virtual-hosted HTTPS host for an s3:// bucket. */
function s3VhostHost(bucket: string, creds?: RemoteCreds): string {
  if (creds?.s3Endpoint) {
    const endpointHost = creds.s3Endpoint.replace(/^https?:\/\//i, "").split("/")[0];
    return `${bucket}.${endpointHost}`;
  }
  const region = creds?.s3Region;
  return region ? `${bucket}.s3.${region}.amazonaws.com` : `${bucket}.s3.amazonaws.com`;
}

export async function resolveRemoteHttpsFetch(stored: StoredRemote): Promise<RemoteFetchPlan> {
  const raw = stored.remoteParquetUrl;
  if (!raw) return { ok: false, unsupported: "no remote URL" };
  // A glob/folder or hive tree is a multi-file scan, which this SINGLE-OBJECT path
  // cannot express. It is no longer a dead end though: the caller enumerates the
  // prefix and range-reads each file through DuckDB in the worker instead
  // (enumerateRemoteParquetFiles + wasm/remote-hive.ts, build log D21). This branch
  // stays so a caller that reaches the single-file path with a folder still fails
  // closed rather than silently fetching one arbitrary shard.
  if (raw.includes("*") || stored.isHivePartitioned) {
    return { ok: false, unsupported: "folder / hive-partitioned source (use the multi-file path)" };
  }

  const allowlist = deriveAllowedEgressHosts(raw, stored.remoteCreds);
  if (allowlist.length === 0) {
    return { ok: false, unsupported: "no allowlisted host (internal/unsupported)" };
  }

  let httpsUrl: string;
  if (/^https:\/\//i.test(raw)) {
    httpsUrl = raw;
  } else if (/^s3:\/\//i.test(raw)) {
    const rest = raw.replace(/^s3:\/\//i, "");
    const slash = rest.indexOf("/");
    if (slash < 0) return { ok: false, unsupported: "s3 url without a key" };
    const bucket = rest.slice(0, slash);
    const key = rest.slice(slash + 1);
    httpsUrl = `https://${s3VhostHost(bucket, stored.remoteCreds)}/${key}`;
  } else {
    return { ok: false, unsupported: `unsupported scheme: ${raw.split(":")[0]}` };
  }

  // Presign only when we actually hold S3 keys; a public / already-signed URL needs
  // nothing (and pre-signing it would be wrong).
  const c = stored.remoteCreds;
  if (c?.s3AccessKeyId && c.s3SecretAccessKey) {
    httpsUrl = await presignS3GetUrl({
      httpsUrl,
      accessKeyId: c.s3AccessKeyId,
      secretAccessKey: c.s3SecretAccessKey,
      region: c.s3Region ?? "us-east-1",
    });
  }

  return { ok: true, url: httpsUrl, allowlist };
}

/**
 * The host-side WASM remote pipeline (build log D13): resolve → fetch through the
 * §6a Rust core → convert parquet→CSV, leaving a local CSV the worker reads on its
 * proven pandas path. The intermediate parquet is deleted; the caller owns the
 * returned CSV (delete it when the run ends). Throws on an unsupported source.
 *
 * Integration edge (spawns egress-fetch + boots DuckDB-WASM) — covered by a gated
 * integration test; the pure resolution above is unit-tested.
 */
export async function materializeRemoteCsvForWasm(
  stored: StoredRemote,
  opts: { workDir: string; binPath?: string; signal?: AbortSignal }
): Promise<{ csvPath: string }> {
  const plan = await resolveRemoteHttpsFetch(stored);
  if (!plan.ok) throw new Error(`WASM remote source unsupported: ${plan.unsupported}`);

  await mkdir(opts.workDir, { recursive: true });
  const id = randomUUID();
  const parquetPath = join(opts.workDir, `wasm-remote-${id}.parquet`);
  const csvPath = join(opts.workDir, `wasm-remote-${id}.csv`);

  await materializeRemoteToFile({
    url: plan.url,
    allowlist: plan.allowlist,
    destPath: parquetPath,
    ...(opts.binPath ? { binPath: opts.binPath } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  try {
    await parquetToCsv(parquetPath, csvPath);
  } finally {
    await unlink(parquetPath).catch(() => {}); // drop the intermediate parquet
  }
  return { csvPath };
}

/**
 * Enumerate every parquet object under a hive/glob source (build log D21).
 *
 * Runs through the SAME authorization path as every other fetch: an S3 listing is
 * `GET /?list-type=2&prefix=…` on the bucket host, which is already on the run's
 * allowlist. No new verb, no new destination, no new capability — which is why
 * lifting the hive gate does not reopen the D20 parity argument. Azure Blob's
 * "List Blobs" is the same ordinary GET on the account host, so it rides the same
 * argument and returns the same `{host, objects}` — one shape for both clouds, so
 * hive aliasing, footer prefetch and range tokens stay cloud-agnostic.
 *
 * Returns objects in listing order (lexicographic by key), so the resulting SQL
 * file list is deterministic across runs — goldens and caches depend on that.
 */
export async function enumerateRemoteParquetFiles(
  stored: StoredRemote,
  opts?: { binPath?: string; signal?: AbortSignal; maxFiles?: number }
): Promise<{ host: string; objects: S3Object[] }> {
  const raw = stored.remoteParquetUrl;
  if (!raw) throw new Error("enumerate: no remote URL");
  const azure = splitAzurePrefix(raw);
  if (azure) return enumerateAzureBlobs(raw, azure, stored, opts);
  const split = splitS3Prefix(raw);
  if (!split) throw new Error(`enumerate: not an enumerable source (s3:// or Azure Blob): ${raw}`);

  const host = s3VhostHost(split.bucket, stored.remoteCreds);
  const allowlist = deriveAllowedEgressHosts(raw, stored.remoteCreds);
  if (allowlist.length === 0)
    throw new Error("enumerate: no allowlisted host (internal/unsupported)");

  const cap = opts?.maxFiles ?? MAX_ENUMERATED_FILES;
  const objects: S3Object[] = [];
  let token: string | undefined;

  // <= 1 page per 1000 objects; the ceiling below also bounds this loop.
  for (let page = 0; page < Math.ceil(cap / 1000) + 1; page++) {
    const qs = new URLSearchParams({ "list-type": "2", prefix: split.prefix, "max-keys": "1000" });
    if (token) qs.set("continuation-token", token);
    let url = `https://${host}/?${qs.toString()}`;
    const c = stored.remoteCreds;
    if (c?.s3AccessKeyId && c.s3SecretAccessKey) {
      url = await presignS3GetUrl({
        httpsUrl: url,
        accessKeyId: c.s3AccessKeyId,
        secretAccessKey: c.s3SecretAccessKey,
        region: c.s3Region ?? "us-east-1",
      });
    }
    const { body } = await fetchRemoteRange({
      url,
      allowlist,
      // A listing has no meaningful range; ask for a generous window and let the
      // core's cap bound it. S3 ignores Range on a listing and returns 200, which
      // fetchRemoteRange reports honestly (empty contentRange) rather than as 206.
      range: "bytes=0-8388607",
      capBytes: 8 * 1024 * 1024,
      ...(opts?.binPath ? { binPath: opts.binPath } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    const parsed = parseS3ListXml(body.toString("utf8"));
    objects.push(...parquetObjectsOnly(parsed.objects));
    if (objects.length > cap) {
      throw new Error(
        `enumerate: source expands to more than ${cap} parquet files — refusing ` +
          `(narrow the source, or use the Docker runtime which scans server-side)`
      );
    }
    if (!parsed.nextToken) return { host, objects };
    token = parsed.nextToken;
  }
  return { host, objects };
}

/**
 * The Azure Blob half of {@link enumerateRemoteParquetFiles}. Same loop, same cap,
 * same page bound, same egress core — only the request shape and the XML differ.
 *
 * Keys come back CONTAINER-QUALIFIED (`container/theme=x/part-0.parquet`) because
 * every consumer of the returned pair builds `https://<host>/<key>`: for S3 the
 * bucket is in the vhost, for Azure the container is the first path segment, so
 * qualifying here is what makes one downstream URL builder correct for both. It
 * also keeps the hive segments in the alias, which is where DuckDB derives
 * partition columns from (see aliasForKey).
 */
async function enumerateAzureBlobs(
  raw: string,
  split: AzurePrefix,
  stored: StoredRemote,
  opts?: { binPath?: string; signal?: AbortSignal; maxFiles?: number }
): Promise<{ host: string; objects: S3Object[] }> {
  // A SAS-signed source is refused HERE rather than half-working: the listing
  // could carry the token, but the per-file read URLs minted downstream cannot,
  // so the run would enumerate happily and then 403 on every byte inside the
  // worker. Failing at the boundary keeps the diagnosis where the cause is.
  if (split.search) {
    throw new Error(
      "enumerate: Azure sources with a SAS/query are not supported for multi-file " +
        "reads — the per-file reads cannot carry the token (use a public container)"
    );
  }
  const allowlist = deriveAllowedEgressHosts(raw, stored.remoteCreds);
  if (allowlist.length === 0)
    throw new Error("enumerate: no allowlisted host (internal/unsupported)");

  const cap = opts?.maxFiles ?? MAX_ENUMERATED_FILES;
  const objects: S3Object[] = [];
  let marker: string | undefined;

  // <= 1 page per 1000 blobs; the ceiling below also bounds this loop.
  for (let page = 0; page < Math.ceil(cap / 1000) + 1; page++) {
    const qs = new URLSearchParams({
      restype: "container",
      comp: "list",
      prefix: split.prefix,
      maxresults: "1000",
    });
    if (marker) qs.set("marker", marker);
    const url = `https://${split.host}/${split.container}?${qs.toString()}`;
    const { body } = await fetchRemoteRange({
      url,
      allowlist,
      // As on the S3 path: a listing has no meaningful range, so ask for a
      // generous window and let the core's cap bound it. Azure ignores Range on
      // a listing and answers 200, which fetchRemoteRange reports honestly.
      range: "bytes=0-8388607",
      capBytes: 8 * 1024 * 1024,
      ...(opts?.binPath ? { binPath: opts.binPath } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    const parsed = parseListBlobs(body.toString("utf8"));
    objects.push(
      ...parquetObjectsOnly(
        parsed.objects.map((o) => ({ key: `${split.container}/${o.key}`, size: o.size }))
      )
    );
    if (objects.length > cap) {
      // Same refusal (and same wording) as the S3 path: a tree this big would
      // mint thousands of tokens and build an unusable SQL list.
      throw new Error(
        `enumerate: source expands to more than ${cap} parquet files — refusing ` +
          `(narrow the source, or use the Docker runtime which scans server-side)`
      );
    }
    if (!parsed.nextMarker) return { host: split.host, objects };
    marker = parsed.nextMarker;
  }
  return { host: split.host, objects };
}
