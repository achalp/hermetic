/**
 * Docker container lifecycle — kill and orphan-reap, owned by the sandbox
 * layer. These used to live inline in pipeline/run-control.ts, which shelled
 * `docker` directly from ABOVE the sandbox abstraction; run-control now keeps
 * only its registry logic and calls down into here.
 *
 * KNOWN GAP (pre-existing, now visible at this seam instead of hidden in
 * pipeline/): only the Docker runtime has kill/reap. A stopped run on
 * e2b/microsandbox relies on the abort signal reaching the executor, and
 * crashed-run sandboxes on those runtimes are cleaned by their own
 * session/VM lifetimes, not by this reaper.
 *
 * Uses `execFile` directly (not docker-utils' `run`): every operation here is
 * best-effort cleanup — a failed `rm -f` on an already-gone container must
 * resolve, never reject or time out a stop request.
 */
import { execFile } from "node:child_process";
import { SANDBOX_CONTAINER_PREFIX } from "@/lib/constants";
import { logger } from "@/lib/logger";

/**
 * Docker label stamped on ephemeral sandbox containers with the owning run's
 * id (docker-executor.ts passes it from SandboxExecOptions.runId). Lets
 * `docker ps --filter label=...` / inspect attribute a container to its run
 * without parsing names.
 */
export const SANDBOX_RUNID_LABEL = "hermetic.runId";

/**
 * Force-remove a container — kills the in-container process too (killing the
 * `docker exec` client alone would not). Always resolves: removing a
 * vanished container is a harmless no-op.
 */
export function killContainer(id: string): Promise<void> {
  return new Promise<void>((resolve) => {
    execFile("docker", ["rm", "-f", id], () => resolve());
  });
}

/**
 * Defense in depth: a container younger than this is SPARED even when
 * unregistered — a true orphan (crash / server restart) is by definition old
 * news by the next sweep tick, while an unregistered-but-young container
 * means the registration path is broken again (the split-brain containerOwner
 * bug killed live runs mid-scan for days because the only trace was an
 * anonymous count).
 */
const ORPHAN_MIN_AGE_MS = 30 * 60 * 1000;

/**
 * Egress gateway (container) and network name prefixes (lib/sandbox/egress.ts).
 * A gateway is `hermetic-egress-gw-<suffix>` and its network
 * `hermetic-egress-<suffix>`, where <suffix> is the analysis container id's last
 * 12 chars — the correlation the sweeper uses to tell a LIVE run's gateway from
 * an orphaned one. (Prefixes duplicated here rather than imported from egress.ts
 * to avoid a module cycle: egress.ts already imports SANDBOX_RUNID_LABEL below.)
 */
const EGRESS_GATEWAY_PREFIX = "hermetic-egress-gw-";
const EGRESS_NETWORK_PREFIX = "hermetic-egress-";

/** `docker ps` names for a prefix (running containers only). */
function psNames(prefix: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["ps", "--filter", `name=${prefix}`, "--format", "{{.Names}}"],
      (err: unknown, stdout: string) => {
        resolve(err ? [] : String(stdout).trim().split("\n").filter(Boolean));
      }
    );
  });
}

/** Container creation time in ms, or NaN when unknown (already gone / odd daemon). */
function containerCreatedMs(name: string): Promise<number> {
  return new Promise((resolve) => {
    execFile("docker", ["inspect", "--format", "{{.Created}}", name], (err, stdout) =>
      resolve(err ? NaN : Date.parse(String(stdout).trim()))
    );
  });
}

/**
 * Reap orphaned analysis containers — the ONLY cleanup path for a
 * `sleep infinity` container whose run died without its finally (a crash, or
 * a server restart that emptied the run registry). Removes any running
 * `hermetic-sandbox-*` container NOT in `activeIds` (the caller's live-run
 * registry — run-control's activeSandboxContainerIds()). Scoped to that
 * prefix so the short-lived schema/fingerprint containers (which self-clean
 * and are never registered) are never touched. Containers younger than
 * ORPHAN_MIN_AGE_MS are spared and logged at warn (see above).
 *
 * ALSO reaps orphaned egress infrastructure (finding M7): a restricted-egress
 * run leaks a `hermetic-egress-gw-*` gateway container and a
 * `hermetic-egress-*` network if the server crashes before teardown. Gateways
 * are correlated to their analysis container by the id suffix — a gateway whose
 * suffix is still an active run is SPARED regardless of age (a legitimately long
 * remote scan must not lose its egress); otherwise it falls under the same age
 * rule. Orphaned egress networks are removed after their gateways (docker
 * refuses to remove an in-use network, so a live run's network is safe anyway).
 *
 * Returns the number of containers reaped (sandbox + gateway).
 */
export async function reapOrphanContainers(activeIds: Set<string>): Promise<number> {
  // Correlate gateways/networks to live runs by the analysis container id suffix
  // the egress names carry (id.slice(-12)).
  const activeSuffixes = new Set([...activeIds].map((id) => id.slice(-12)));

  const [sandboxNames, gatewayNames] = await Promise.all([
    psNames(SANDBOX_CONTAINER_PREFIX),
    psNames(EGRESS_GATEWAY_PREFIX),
  ]);

  const sandboxCandidates = sandboxNames.filter((n) => !activeIds.has(n));
  // A gateway's suffix follows the `hermetic-egress-gw-` prefix; spare it while
  // its analysis container is a live run.
  const gatewayCandidates = gatewayNames.filter(
    (n) => !activeSuffixes.has(n.slice(EGRESS_GATEWAY_PREFIX.length))
  );

  const orphans: string[] = [];
  const spared: string[] = [];
  await Promise.all(
    [...sandboxCandidates, ...gatewayCandidates].map(async (n) => {
      const createdMs = await containerCreatedMs(n);
      // Unparseable/missing Created (container already gone, odd daemon) → treat
      // as reapable; `rm -f` on a vanished container is a harmless no-op.
      if (Number.isFinite(createdMs) && Date.now() - createdMs < ORPHAN_MIN_AGE_MS) {
        spared.push(n);
      } else {
        orphans.push(n);
      }
    })
  );
  await Promise.all(orphans.map((n) => killContainer(n)));

  // Remove orphaned egress networks: any hermetic-egress-* network whose suffix
  // is not an active run. docker refuses to remove an in-use network, so a live
  // run's network survives even if it isn't in activeSuffixes — belt and braces.
  await reapOrphanEgressNetworks(activeSuffixes);

  if (spared.length) {
    logger.warn(
      "Sweeper spared unregistered-but-young sandbox/gateway containers — registration broken?",
      {
        names: spared,
      }
    );
  }
  if (orphans.length) {
    logger.info("Reaped orphan sandbox/gateway containers", {
      count: orphans.length,
      names: orphans,
    });
  }
  return orphans.length;
}

/** Remove leaked egress networks (see reapOrphanContainers). Best-effort. */
async function reapOrphanEgressNetworks(activeSuffixes: Set<string>): Promise<void> {
  const names = await new Promise<string[]>((resolve) => {
    execFile(
      "docker",
      ["network", "ls", "--filter", `name=${EGRESS_NETWORK_PREFIX}`, "--format", "{{.Name}}"],
      (err: unknown, stdout: string) => {
        resolve(err ? [] : String(stdout).trim().split("\n").filter(Boolean));
      }
    );
  });
  const orphans = names.filter((n) => {
    // A network is `hermetic-egress-<suffix>`; the gateway container shares the
    // EGRESS_NETWORK_PREFIX, so exclude the `gw-` names (containers, not nets —
    // ls wouldn't list them, but guard anyway) and spare live suffixes.
    if (n.startsWith(EGRESS_GATEWAY_PREFIX)) return false;
    return !activeSuffixes.has(n.slice(EGRESS_NETWORK_PREFIX.length));
  });
  await Promise.all(
    orphans.map(
      (n) =>
        new Promise<void>((resolve) => {
          execFile("docker", ["network", "rm", n], () => resolve());
        })
    )
  );
  if (orphans.length) {
    logger.info("Removed orphan egress networks", { count: orphans.length, names: orphans });
  }
}
