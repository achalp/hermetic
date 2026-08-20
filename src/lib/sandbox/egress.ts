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
import { sandboxHardeningRunArgs } from "./hardening";
import { sandboxMemoryRunArgs } from "./memory-budget";
import { isInternalHostname } from "@/lib/parquet/duckdb-source";
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
    if (!h) return;
    const host = h.toLowerCase();
    // SSRF guard (finding M2): never open the proxy toward an internal target.
    // A custom s3Endpoint or an https:// source host of 169.254.169.254 (cloud
    // metadata), an RFC-1918 / loopback address, or a *.internal name would
    // otherwise be added verbatim and become reachable from the gateway (which
    // sits on the bridge). The public bucket vhosts pass unchanged.
    if (isInternalHostname(host)) {
      logger.warn("egress: refusing internal host in allowlist (SSRF)", { host });
      return;
    }
    hosts.add(host);
  };

  if (/^s3:\/\//i.test(url)) {
    const bucket = url.replace(/^s3:\/\//i, "").split("/")[0];
    if (creds?.s3Endpoint) {
      // Custom endpoint (R2/MinIO/GCS-interop): its host, plus the
      // virtual-hosted-style variant DuckDB may use. The bare endpoint host
      // stays: path-style is the norm on custom endpoints, and the endpoint
      // domain scopes to the user's own account, not the world's buckets.
      const endpointHost = creds.s3Endpoint.replace(/^https?:\/\//i, "").split("/")[0];
      // If the endpoint host is internal, the WHOLE endpoint is an untrusted
      // SSRF target — add neither the bare host nor the vhost variant (whose
      // `bucket.` prefix would otherwise dodge the per-host check). (finding M2)
      if (isInternalHostname(endpointHost)) {
        logger.warn("egress: refusing internal s3Endpoint (SSRF)", { host: endpointHost });
      } else {
        add(endpointHost);
        add(`${bucket}.${endpointHost}`);
      }
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
 * The egress posture for a remote source. The sandbox runs LLM-generated code
 * (DuckDB inside it), so egress control exists to keep injected code from
 * exfiltrating whatever the container holds — data and, when present,
 * credentials.
 *
 *  - No remote source URL (local CSV/parquet, warehouse-materialized, or an
 *    underivable ref): "deny" — --network none. Network is a property of the
 *    SOURCE; a local-data run never earns egress (finding 01).
 *  - Remote URL (public OR credentialed): "allowlist" with the derived source
 *    hosts, via the L7 proxy. The container joins an internal network with no
 *    route out except the proxy, and the proxy only opens toward the source's
 *    own host — so injected code can reach the bucket it's reading and nothing
 *    else (no attacker host, no cloud metadata, no RFC-1918/loopback). This is
 *    the only tier that stops EXFILTRATION, and the proxy's splice(2) relay
 *    (docker/sandbox/egress-proxy.py) makes it near direct-egress speed, so
 *    there's no throughput reason to fall back to a weaker native-egress tier.
 *    It also needs no host privilege (Docker network + a gateway container, not
 *    host iptables), so it works on a non-root server.
 *  - Remote URL but no host derivable (unparseable): "deny" — fail closed.
 */
export function egressPolicyFor(
  url: string | undefined,
  creds?: RemoteCreds
): { mode: "allowlist" | "deny"; hosts?: string[] } {
  if (!url) return { mode: "deny" };
  const hosts = deriveAllowedEgressHosts(url, creds);
  if (hosts.length === 0) return { mode: "deny" };
  return { mode: "allowlist", hosts };
}

export interface EgressNetwork {
  /** Value for the analysis container's `--network`. */
  networkName: string;
  /** Env vars to set on the analysis container. */
  env: Record<string, string>;
  /**
   * The gateway proxy's own log (stdout+stderr) — its `DENY <host>` lines and
   * upstream connect errors. Read BEFORE teardown to make an egress failure
   * diagnosable (which host was blocked, or that the proxy never bound) instead
   * of a black box. Best-effort: "" when the gateway is already gone.
   */
  proxyLogs(): Promise<string>;
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
        // Harden the gateway like the analysis container (finding M5): the proxy
        // needs no Linux capabilities (binds an unprivileged port, opens plain
        // outbound TCP), so --cap-drop ALL applies cleanly, --pids-limit caps the
        // proxy's thread-per-tunnel growth, and --memory bounds its relay-pipe
        // buffers — turning an unbounded DoS surface into a bounded one.
        ...(await sandboxHardeningRunArgs()),
        ...(await sandboxMemoryRunArgs()),
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
    // The proxy above is started fire-and-forget (`exec -d`); WAIT for it to
    // accept a connection before returning. Otherwise the analysis container's
    // first read can race an unbound listener and fail as a spurious "network
    // error" (this exact symptom: a fast connection failure with no cause). The
    // poll runs inside ONE docker exec (python retries locally) — a refused
    // localhost connect returns instantly, so a ready proxy passes in ~one
    // iteration; a proxy that never binds still returns after ~5s and the run's
    // own network-error path (now log-capturing) reports why.
    const readyScript =
      "import socket, time\n" +
      "for _ in range(50):\n" +
      "    try:\n" +
      `        socket.create_connection(("127.0.0.1", ${EGRESS_PROXY_PORT}), 0.3).close()\n` +
      "        break\n" +
      "    except OSError:\n" +
      "        time.sleep(0.1)\n";
    await run("docker", ["exec", gatewayName, "python3", "-c", readyScript], {
      timeoutMs: 15_000,
    }).catch(() => {});
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
    proxyLogs: async () => {
      const r = await run("docker", ["logs", gatewayName], { timeoutMs: 10_000 }).catch(() => null);
      return r ? `${r.stdout}${r.stderr}` : "";
    },
    teardown: async () => {
      await run("docker", ["rm", "-f", gatewayName]).catch(() => {});
      await run("docker", ["network", "rm", networkName]).catch(() => {});
    },
  };
}
