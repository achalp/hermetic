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
 * Reap orphaned analysis containers — the ONLY cleanup path for a
 * `sleep infinity` container whose run died without its finally (a crash, or
 * a server restart that emptied the run registry). Removes any running
 * `hermetic-sandbox-*` container NOT in `activeIds` (the caller's live-run
 * registry — run-control's activeSandboxContainerIds()). Scoped to that
 * prefix so the short-lived schema/fingerprint containers (which self-clean
 * and are never registered) are never touched. Containers younger than
 * ORPHAN_MIN_AGE_MS are spared and logged at warn (see above). Returns the
 * number reaped.
 */
export async function reapOrphanContainers(activeIds: Set<string>): Promise<number> {
  const names = await new Promise<string[]>((resolve) => {
    execFile(
      "docker",
      ["ps", "--filter", `name=${SANDBOX_CONTAINER_PREFIX}`, "--format", "{{.Names}}"],
      (err: unknown, stdout: string) => {
        resolve(err ? [] : String(stdout).trim().split("\n").filter(Boolean));
      }
    );
  });
  const candidates = names.filter((n) => !activeIds.has(n));
  const orphans: string[] = [];
  const spared: string[] = [];
  await Promise.all(
    candidates.map(async (n) => {
      const createdIso = await new Promise<string | null>((resolve) => {
        execFile("docker", ["inspect", "--format", "{{.Created}}", n], (err, stdout) =>
          resolve(err ? null : String(stdout).trim())
        );
      });
      // Unparseable/missing Created (container already gone, odd daemon) → treat
      // as reapable; `rm -f` on a vanished container is a harmless no-op.
      const createdMs = createdIso ? Date.parse(createdIso) : NaN;
      if (Number.isFinite(createdMs) && Date.now() - createdMs < ORPHAN_MIN_AGE_MS) {
        spared.push(n);
      } else {
        orphans.push(n);
      }
    })
  );
  await Promise.all(orphans.map((n) => killContainer(n)));
  if (spared.length) {
    logger.warn("Sweeper spared unregistered-but-young sandbox containers — registration broken?", {
      names: spared,
    });
  }
  if (orphans.length) {
    logger.info("Reaped orphan sandbox containers", { count: orphans.length, names: orphans });
  }
  return orphans.length;
}
