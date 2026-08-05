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
      // virtual-hosted-style variant DuckDB may use.
      const endpointHost = creds.s3Endpoint.replace(/^https?:\/\//i, "").split("/")[0];
      add(endpointHost);
      add(`${bucket}.${endpointHost}`);
    } else {
      const region = creds?.s3Region;
      // DuckDB httpfs uses virtual-hosted style by default and path style as
      // fallback; allow both, with and without an explicit region.
      add(`${bucket}.s3.amazonaws.com`);
      add("s3.amazonaws.com");
      if (region) {
        add(`${bucket}.s3.${region}.amazonaws.com`);
        add(`s3.${region}.amazonaws.com`);
      }
    }
  } else if (/^gs:\/\//i.test(url)) {
    const bucket = url.replace(/^gs:\/\//i, "").split("/")[0];
    add("storage.googleapis.com");
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
  return {
    networkName,
    env: {
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      HERMETIC_HTTP_PROXY: proxyUrl,
      NO_PROXY: "localhost,127.0.0.1",
    },
    teardown: async () => {
      await run("docker", ["rm", "-f", gatewayName]).catch(() => {});
      await run("docker", ["network", "rm", networkName]).catch(() => {});
    },
  };
}
