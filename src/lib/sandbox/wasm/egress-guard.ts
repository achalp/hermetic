/**
 * The §6a egress AUTHORIZATION decision — the pure, JS-side guard behind the
 * trusted Rust core's fetch. The worker (untrusted) can only REQUEST a URL; this
 * decides whether the core may fetch it, replicating Docker's L7-allowlist
 * guarantees and the v2.3 re-review's provenance pins:
 *
 *  - The allowlist comes from the STORED source URL (in the authorization the
 *    SIDECAR set out-of-band), NEVER the worker's URL. The worker's URL is
 *    honored only if its host is a member; the path is an opaque object key.
 *  - The request's runId must match the run's authorization — a worker cannot
 *    name another run's (or another source's) grant (cross-source confused
 *    deputy, re-review #1.2).
 *  - A run with NO remote source has an empty allowlist ⇒ every fetch refused
 *    (local-run `connect-src 'none'` parity, re-review #5).
 *  - Only http(s); the host match is exact (vhost-scoped by derivation) and
 *    case-insensitive. Resolve-and-reject / redirect / cert / read-only-GET are
 *    the CORE's job at fetch time — this is the pre-flight authorization.
 *
 * Pure + dependency-free (contracts-only) → 100%-covered and reusable by the
 * Node-worker and browser relays alike.
 */
import type { EgressRequest, EgressAuthorization, EgressVerdict } from "./contract";

export function authorizeEgress(req: EgressRequest, auth: EgressAuthorization): EgressVerdict {
  // The worker cannot borrow another run's grant.
  if (req.runId !== auth.runId) {
    return { allowed: false, reason: "run mismatch: request is not for the authorized run" };
  }

  // No remote source authorized for this run ⇒ no egress at all.
  if (auth.allowedHosts.length === 0) {
    return { allowed: false, reason: "no remote source authorized for this run" };
  }

  let host: string;
  let protocol: string;
  try {
    const u = new URL(req.url);
    host = u.hostname.toLowerCase();
    protocol = u.protocol;
  } catch {
    return { allowed: false, reason: "unparseable URL" };
  }

  if (protocol !== "http:" && protocol !== "https:") {
    return { allowed: false, reason: `unsupported scheme: ${protocol}` };
  }

  // Host must be a member of the STORED-source-derived allowlist.
  const allowed = auth.allowedHosts.some((h) => h.toLowerCase() === host);
  if (!allowed) {
    return { allowed: false, reason: `host not in the source allowlist: ${host}` };
  }

  return { allowed: true, host };
}
