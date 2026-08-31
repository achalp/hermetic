/**
 * Fetch a manifest document through the Rust egress core (spec §5.2) — never a
 * plain host-side fetch. Same guarantees as every other remote read: allowlist,
 * resolve-and-reject on internal IPs, IP pinning, no-follow redirects, and a
 * streaming byte cap. The manifest URL itself passes the same injection /
 * internal-host gate as parquet URLs (`isSafeParquetUrl` is a shape gate, not a
 * .parquet gate) plus a manifest-shaped extension check.
 *
 * Integration edge (spawns the egress bin) — the pure orchestration around it
 * (lib/manifest/connect.ts) is unit-tested with this injected.
 */
import { isSafeParquetUrl } from "@/lib/parquet/duckdb-source";
import { resolveRemoteHttpsFetch } from "@/lib/sandbox/remote-fetch";
import { fetchRemoteRange } from "@/lib/sandbox/egress-fetch";
import type { RemoteCreds } from "@/lib/contracts/storage-types";
import { ManifestError, MAX_MANIFEST_BYTES, isManifestUrl } from "./shared";

export { isManifestUrl };

export async function fetchManifestText(url: string, creds?: RemoteCreds): Promise<string> {
  if (!isSafeParquetUrl(url) || !isManifestUrl(url)) {
    throw new ManifestError(
      "Enter a valid https:// or s3:// manifest URL ending in .json (no quotes or special characters)."
    );
  }
  const plan = await resolveRemoteHttpsFetch({
    remoteParquetUrl: url,
    ...(creds ? { remoteCreds: creds } : {}),
  });
  if (!plan.ok) {
    throw new ManifestError(`Cannot fetch this manifest: ${plan.unsupported}`);
  }
  const { body, total } = await fetchRemoteRange({
    url: plan.url,
    allowlist: plan.allowlist,
    range: `bytes=0-${MAX_MANIFEST_BYTES - 1}`,
    capBytes: MAX_MANIFEST_BYTES,
  });
  // A ranged GET on an oversized document truncates mid-JSON, which would parse
  // -fail with a misleading message — name the real problem instead.
  if (total !== null && total > MAX_MANIFEST_BYTES) {
    throw new ManifestError(
      `This manifest is ${Math.round(total / 1e6)} MB — larger than the ` +
        `${Math.round(MAX_MANIFEST_BYTES / 1e6)} MB limit.`
    );
  }
  return body.toString("utf8");
}
