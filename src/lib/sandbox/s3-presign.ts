/**
 * SigV4 query pre-signing for S3 GET URLs (build log D13). Used HOST-SIDE by the
 * WASM remote path: the sidecar pre-signs the source URL with the user's S3 keys
 * (which NEVER leave the machine — they only sign), then `egress-fetch` fetches the
 * pre-signed URL through the §6a Rust core (so signing AND SSRF/IP-pinning both
 * hold). Uses the battle-tested `@smithy/signature-v4` — no hand-rolled crypto.
 *
 * `signingDate` is injectable so the signature is deterministic under test; in
 * production the caller omits it and the SDK stamps the current time. The signed URL
 * is short-lived (default 15 min) — plenty for a single materialize fetch.
 */
import { SignatureV4 } from "@smithy/signature-v4";
import { HttpRequest } from "@smithy/protocol-http";
import { Sha256 } from "@aws-crypto/sha256-js";

export interface PresignOptions {
  httpsUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  /** URL lifetime in seconds (default 900). */
  expiresIn?: number;
  /** Deterministic signing time (tests); omit in production. */
  signingDate?: Date;
}

export async function presignS3GetUrl(o: PresignOptions): Promise<string> {
  const u = new URL(o.httpsUrl);
  const query: Record<string, string> = {};
  u.searchParams.forEach((v, k) => {
    query[k] = v;
  });

  const signer = new SignatureV4({
    credentials: { accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey },
    region: o.region,
    service: "s3",
    sha256: Sha256,
    // S3 does NOT double-escape the path (a key with '/' stays as-is).
    uriEscapePath: false,
    applyChecksum: false,
  });

  const req = new HttpRequest({
    method: "GET",
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port ? Number(u.port) : undefined,
    path: u.pathname,
    query,
    headers: { host: u.host },
  });

  const signed = await signer.presign(req, {
    expiresIn: o.expiresIn ?? 900,
    ...(o.signingDate ? { signingDate: o.signingDate } : {}),
  });

  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(signed.query ?? {})) {
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, x));
    else if (v != null) sp.set(k, String(v));
  }
  const qs = sp.toString();
  const port = signed.port ? `:${signed.port}` : "";
  return `${signed.protocol}//${signed.hostname}${port}${signed.path}${qs ? `?${qs}` : ""}`;
}
