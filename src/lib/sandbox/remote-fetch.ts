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
import { materializeRemoteToFile } from "./egress-fetch";
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
  // A glob/folder or hive tree is a multi-file scan — not a single-file GET.
  if (raw.includes("*") || stored.isHivePartitioned) {
    return { ok: false, unsupported: "folder / hive-partitioned source (needs Docker)" };
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
