/**
 * Bucket-scoped egress for networked sandbox runs (mcp-server spec §1
 * "known residual" — now closed for remote-source analyses).
 *
 * Mechanism: the analysis container joins an INTERNAL Docker network (no
 * outbound route at all). A gateway container — same sandbox image, running
 * the hermetic-owned allowlist proxy (docker/sandbox/egress-proxy.py) — sits
 * on both that internal network and the default bridge, and forwards ONLY to
 * the derived bucket hosts (HTTPS as CONNECT tunnels, so TLS certificates
 * validate end-to-end against the real host). Python's urllib/requests pick
 * the proxy up from the standard env vars; DuckDB gets it via the prelude's
 * connect patch (HERMETIC_HTTP_PROXY). Fail-closed: any path that misses the
 * proxy hits a network with no route out.
 */
import { readFileSync } from "node:fs";
import { hermeticPaths } from "@/lib/paths";
import { DOCKER_SANDBOX_IMAGE } from "@/lib/constants";
import { run } from "./docker-utils";
import { logger } from "@/lib/logger";
import { SANDBOX_RUNID_LABEL } from "./lifecycle";
import type { RemoteCreds } from "@/lib/contracts/storage-types";

export const EGRESS_PROXY_PORT = 3128;

/**
 * The exact hostnames a remote Parquet source may be read from, derived from
 * its URL + credentials. Deny-by-default: anything not derivable is not
 * allowed, and an empty result means "do not grant network at all".
 */
export function deriveAllowedEgressHosts(url: string, creds?: RemoteCreds): string[] {
  const hosts = new Set<string>();
  const add = (h: string | null | undefined) => {
    if (h) hosts.add(h.toLowerCase());
  };

  if (/^s3:\/\//i.test(url)) {
    const bucket = url.replace(/^s3:\/\//i, "").split("/")[0];
    if (creds?.s3Endpoint) {
      // Custom endpoint (R2/MinIO/GCS-interop): its host, plus the
      // virtual-hosted-style variant DuckDB may use. The bare endpoint host
      // stays: path-style is the norm on custom endpoints, and the endpoint
      // domain scopes to the user's own account, not the world's buckets.
      const endpointHost = creds.s3Endpoint.replace(/^https?:\/\//i, "").split("/")[0];
      add(endpointHost);
      add(`${bucket}.${endpointHost}`);
    } else {
      const region = creds?.s3Region;
      // VIRTUAL-HOSTED hosts ONLY. CONNECT tunnels are opaque TLS — the
      // proxy filters by hostname and never sees the path — so allowing the
      // generic path-style host (s3.amazonaws.com) allows EVERY bucket on
      // AWS, quietly re-opening the exfiltration door this allowlist exists
      // to close (a PUT to s3.amazonaws.com/attacker-bucket rides the same
      // tunnel). The prelude pins DuckDB to vhost style under the proxy so
      // reads keep working.
      add(`${bucket}.s3.amazonaws.com`);
      if (region) add(`${bucket}.s3.${region}.amazonaws.com`);
    }
  } else if (/^gs:\/\//i.test(url)) {
    const bucket = url.replace(/^gs:\/\//i, "").split("/")[0];
    // Same rule as AWS: bucket-scoped vhost only, never the generic host.
    add(`${bucket}.storage.googleapis.com`);
  } else if (/^https?:\/\//i.test(url)) {
    try {
      add(new URL(url).hostname);
    } catch {
      // unparseable URL grants nothing
    }
  }
  return [...hosts];
}

/**
 * The egress posture for a remote source, tiered by WHAT IS IN THE CONTAINER
 * (proxy settlement 2026-08-13; L3 rework, finding 04): the sandbox runs
 * LLM-generated code, and DuckDB runs inside that code — the allowlist's
 * purpose is to keep injected code from exfiltrating what the container holds.
 *
 *  - No remote source URL (local CSV/parquet, warehouse-materialized, or an
 *    underivable ref): "deny" — --network none. Network is a property of the
 *    SOURCE; a local-data run never earns egress (finding 01).
 *  - Remote URL, NO stored credentials (public bucket, e.g. Overture): the
 *    container holds nothing secret, but must still be kept from reaching cloud
 *    metadata / private ranges / loopback — "l3blocked" runs it on a dedicated
 *    bridge with kernel DROP rules for those ranges (egress-l3.ts) and native
 *    line-rate egress to the public internet. This replaces the old "open"
 *    tier, which reached 169.254.169.254 + RFC-1918 + loopback unrestricted.
 *  - Credentials present: they enter the container env for DuckDB, which is
 *    exactly the exfiltration case — "allowlist" with the derived hosts, via
 *    the L7 proxy (hostname allowlisting genuinely needs L7).
 *  - Credentials present but no host derivable (unparseable URL): "deny" —
 *    fail closed, never open.
 */
export function egressPolicyFor(
  url: string | undefined,
  creds?: RemoteCreds
): { mode: "l3blocked" | "allowlist" | "deny"; hosts?: string[] } {
  if (!url) return { mode: "deny" };
  const hasCreds = Boolean(creds?.s3AccessKeyId || creds?.s3SecretAccessKey);
  if (!hasCreds) return { mode: "l3blocked" };
  const hosts = deriveAllowedEgressHosts(url, creds);
  if (hosts.length === 0) return { mode: "deny" };
  return { mode: "allowlist", hosts };
}

export interface EgressNetwork {
  /** Value for the analysis container's `--network`. */
  networkName: string;
  /** Env vars to set on the analysis container. */
  env: Record<string, string>;
  teardown(): Promise<void>;
}

/**
 * Create the internal network + gateway proxy for one run. The caller MUST
 * call teardown() in its finally.
 */
export async function setupEgressNetwork(
  runId: string,
  allowHosts: string[]
): Promise<EgressNetwork> {
  const networkName = `hermetic-egress-${runId}`;
  const gatewayName = `hermetic-egress-gw-${runId}`;
  const proxyScript = readFileSync(hermeticPaths.sandboxEgressProxyFile(), "utf-8");

  await run("docker", ["network", "create", "--internal", networkName], { timeoutMs: 15_000 });
  try {
    // Gateway: internal net first (so the analysis container can name it),
    // then also the default bridge for real egress. host-gateway mapping lets
    // integration tests allow a host-served origin.
    await run(
      "docker",
      [
        "run",
        "-d",
        "--name",
        gatewayName,
        // Stamp the run label so the orphan sweeper can reap a gateway (and its
        // network) whose run crashed without teardown (finding M7).
        "--label",
        `${SANDBOX_RUNID_LABEL}=${runId}`,
        "--network",
        networkName,
        "--add-host=host.docker.internal:host-gateway",
        "-e",
        `ALLOW_HOSTS=${allowHosts.join(",")}`,
        "-e",
        `PROXY_PORT=${EGRESS_PROXY_PORT}`,
        DOCKER_SANDBOX_IMAGE,
        "sleep",
        "infinity",
      ],
      { timeoutMs: 15_000 }
    );
    await run("docker", ["network", "connect", "bridge", gatewayName], { timeoutMs: 15_000 });
    await run("docker", ["exec", "-i", gatewayName, "sh", "-c", "cat > /tmp/egress-proxy.py"], {
      input: proxyScript,
      timeoutMs: 15_000,
    });
    await run("docker", ["exec", "-d", gatewayName, "python3", "/tmp/egress-proxy.py"], {
      timeoutMs: 15_000,
    });
  } catch (err) {
    await run("docker", ["rm", "-f", gatewayName]).catch(() => {});
    await run("docker", ["network", "rm", networkName]).catch(() => {});
    throw err;
  }

  const proxyUrl = `http://${gatewayName}:${EGRESS_PROXY_PORT}`;
  logger.info("Egress-restricted network up", { networkName, allowHosts });
  // The AWS allowlist carries vhost hosts ONLY (deriveAllowedEgressHosts) —
  // DuckDB must therefore use virtual-hosted URLs or every read 403s at the
  // proxy. The prelude reads this and pins s3_url_style.
  const awsVhost = allowHosts.some((h) => h.endsWith(".amazonaws.com"));
  return {
    networkName,
    env: {
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      HERMETIC_HTTP_PROXY: proxyUrl,
      ...(awsVhost ? { HERMETIC_S3_URL_STYLE: "vhost" } : {}),
      NO_PROXY: "localhost,127.0.0.1",
    },
    teardown: async () => {
      await run("docker", ["rm", "-f", gatewayName]).catch(() => {});
      await run("docker", ["network", "rm", networkName]).catch(() => {});
    },
  };
}
