/**
 * L3 CIDR-blocked egress — the middle tier between `--network none` and the
 * L7 allowlist proxy (egress.ts), added for the no-credentials public-bucket
 * case (egress rework, finding 04).
 *
 * The L7 proxy hostname-allowlists genuinely-secret credentialed reads, but its
 * userspace HTTP CONNECT relay is GIL-bound and cost a 30x slowdown on
 * planet-scale scans (run e1c88a71: 45s -> 25min). A public bucket holds
 * nothing to exfiltrate, so it does not need hostname filtering — it needs the
 * container kept from reaching INWARD (cloud metadata, private ranges,
 * loopback). This tier gives it native line-rate egress to the public internet
 * on a dedicated bridge while the KERNEL drops packets aimed at the blocked
 * ranges via DOCKER-USER (the chain Docker guarantees is traversed first for
 * all container traffic).
 *
 * Fail SAFE: if the dedicated network or the iptables rules can't be installed
 * (host lacks NET_ADMIN, iptables absent), setup returns null and the caller
 * falls back to `--network none` — NEVER to open bridge egress.
 */
import { run } from "./docker-utils";
import { logger } from "@/lib/logger";

/** Dedicated, reusable bridge network for the L3-blocked tier. Created once and
 *  kept across runs (unlike the per-run L7 egress networks). */
export const L3_SANDBOX_NETWORK = "hermetic-sandbox-l3";

/** Fixed subnet for the dedicated network, so the DROP rules can scope to
 *  exactly this network's traffic and never touch other containers. */
export const L3_SANDBOX_SUBNET = "172.31.250.0/24";

/**
 * The ranges the L3-blocked sandbox must NEVER reach. Native egress to the
 * public internet is allowed; the kernel drops packets aimed at:
 *  - the cloud instance-metadata endpoint (SSRF -> credential theft),
 *  - all RFC-1918 private ranges + link-local,
 *  - loopback,
 * for both IPv4 and IPv6.
 */
export const L3_BLOCKED_CIDRS: readonly string[] = [
  "169.254.169.254/32", // cloud instance metadata (IMDS)
  "169.254.0.0/16", // IPv4 link-local (metadata lives here)
  "127.0.0.0/8", // IPv4 loopback
  "10.0.0.0/8", // RFC-1918 private
  "172.16.0.0/12", // RFC-1918 private
  "192.168.0.0/16", // RFC-1918 private
  "::1/128", // IPv6 loopback
  "fc00::/7", // IPv6 unique-local (private)
];

function isV6(cidr: string): boolean {
  return cidr.includes(":");
}

/**
 * The iptables/ip6tables argument vectors that DROP traffic from the sandbox
 * subnet to one blocked CIDR — a `-C` check spec and an `-I` insert spec so the
 * install is idempotent (never double-inserts). Pure/exported for unit tests.
 * IPv6 rules omit the source match: the dedicated network is IPv4-only, so they
 * are belt-and-braces and must not reference the IPv4 subnet.
 */
export function l3DropRuleSpec(cidr: string): {
  bin: "iptables" | "ip6tables";
  check: string[];
  insert: string[];
} {
  const v6 = isV6(cidr);
  const match = v6
    ? ["-d", cidr, "-j", "DROP"]
    : ["-s", L3_SANDBOX_SUBNET, "-d", cidr, "-j", "DROP"];
  return {
    bin: v6 ? "ip6tables" : "iptables",
    check: ["-C", "DOCKER-USER", ...match],
    insert: ["-I", "DOCKER-USER", "1", ...match],
  };
}

// One attempt per process: cache a SUCCESSFUL setup; a failure is not cached so
// a transient condition (daemon still booting) can be retried on a later run.
let l3Ready: Promise<string | null> | null = null;

/**
 * Ensure the dedicated L3-blocked network exists and its DROP rules are
 * installed, returning the network name on success or null on ANY failure
 * (caller then fails safe to `--network none`).
 */
export function setupL3BlockedNetwork(): Promise<string | null> {
  if (!l3Ready) {
    l3Ready = installL3Network().catch((err) => {
      logger.warn("L3-blocked egress setup failed — caller must fail safe to --network none", {
        error: err instanceof Error ? err.message : String(err),
      });
      l3Ready = null; // don't poison future runs
      return null;
    });
  }
  return l3Ready;
}

/** Test-only: forget the memoized setup so a suite can exercise both paths. */
export function resetL3SetupForTests(): void {
  l3Ready = null;
}

async function installL3Network(): Promise<string | null> {
  // 1. Ensure the dedicated bridge network (idempotent — tolerate "exists").
  const inspect = await run("docker", ["network", "inspect", L3_SANDBOX_NETWORK], {
    timeoutMs: 10_000,
  }).catch(() => null);
  if (!inspect || inspect.exitCode !== 0) {
    const created = await run(
      "docker",
      ["network", "create", "--subnet", L3_SANDBOX_SUBNET, L3_SANDBOX_NETWORK],
      { timeoutMs: 15_000 }
    );
    if (created.exitCode !== 0 && !/already exists/i.test(created.stderr)) {
      throw new Error(`docker network create failed: ${created.stderr.slice(0, 200)}`);
    }
  }

  // 2. Install the DOCKER-USER DROP rules once each. The IPv4 rules are
  //    load-bearing (fail the whole setup if they can't be installed — never
  //    run open); IPv6 rules are best-effort (the network is IPv4-only).
  for (const cidr of L3_BLOCKED_CIDRS) {
    const { bin, check, insert } = l3DropRuleSpec(cidr);
    const already = await run(bin, check, { timeoutMs: 10_000 }).catch(() => null);
    if (already && already.exitCode === 0) continue; // rule present — don't double-insert
    const ins = await run(bin, insert, { timeoutMs: 10_000 }).catch((e) => {
      if (bin === "ip6tables") return { exitCode: 1, stdout: "", stderr: String(e) };
      throw e;
    });
    if (ins.exitCode !== 0 && bin === "iptables") {
      throw new Error(`iptables install failed for ${cidr}: ${ins.stderr.slice(0, 200)}`);
    }
  }

  logger.info("L3-blocked egress network ready", {
    network: L3_SANDBOX_NETWORK,
    blocked: L3_BLOCKED_CIDRS.length,
  });
  return L3_SANDBOX_NETWORK;
}
