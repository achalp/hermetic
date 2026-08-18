/**
 * Container hardening `docker run` args (finding M10). The sandbox workload is
 * non-root Python; each flag closes a privilege/DoS avenue for injected code:
 *   --pids-limit          caps fork bombs
 *   --cpus                bounds CPU so one run can't starve the host/others
 *   --cap-drop ALL        the workload needs no Linux capabilities
 *
 * NOTE: `--security-opt no-new-privileges` was tried and REMOVED — against this
 * image it makes `execve` of python3 fail with "operation not permitted"
 * (EPERM at exec time), breaking every run. `--cap-drop ALL` already removes
 * the capabilities a setuid escalation could grant, so dropping no-new-privileges
 * costs almost nothing. Any hardening flag added here MUST be verified against a
 * live container (see hardening.test.ts), not just asserted in the arg array.
 */
import os from "node:os";
import { run } from "./docker-utils";
import { logger, errMessage } from "@/lib/logger";

/** Max processes/threads per sandbox container. Generous for DuckDB's thread
 *  pool + Python, tight enough to stop a fork bomb. */
export const SANDBOX_PIDS_LIMIT = 512;

/** Fraction of host cores a single sandbox may burn (leaves headroom for the
 *  Next.js server + other concurrent runs). */
export const SANDBOX_CPU_FRACTION = 0.75;

/** The host-derived share of cores — an upper bound, NOT the final `--cpus`
 *  value. See sandboxCpuLimit(): the daemon may see fewer CPUs than the host. */
export function sandboxCpuBudget(): number {
  const cores = os.cpus().length || 4;
  return Math.max(1, Math.floor(cores * SANDBOX_CPU_FRACTION));
}

// Cache only a SUCCESSFUL probe — same policy as memory-budget's MemTotal
// probe: the daemon's CPU count is fixed for the process's lifetime, but a
// transient `docker info` failure must not poison the value forever.
let cachedDaemonCpus: number | null = null;
let inflightCpus: Promise<number | null> | null = null;

/**
 * CPU count as seen by the Docker DAEMON — the VM allocation on macOS
 * (colima/Docker Desktop), host cores on native Linux. null when it cannot be
 * determined (docker absent, `docker info` failed/timed out, unparseable).
 *
 * WHY the daemon and not the host: on macOS the daemon runs in a VM whose CPU
 * slice can be far smaller than the Mac's core count (e.g. a 10-core Mac with
 * a 4-CPU colima VM). `docker run --cpus N` is REJECTED outright when N
 * exceeds the daemon's CPUs ("Range of CPUs is from 0.01 to 4.00"), so a
 * host-derived value silently broke every container creation on such setups.
 */
export function getDaemonCpuCount(): Promise<number | null> {
  if (cachedDaemonCpus != null) return Promise.resolve(cachedDaemonCpus);
  if (!inflightCpus) {
    inflightCpus = run("docker", ["info", "--format", "{{.NCPU}}"], { timeoutMs: 5_000 })
      .then((r) => {
        const cpus = parseInt(r.stdout.trim(), 10);
        if (r.exitCode === 0 && Number.isFinite(cpus) && cpus > 0) {
          cachedDaemonCpus = cpus;
          return cpus;
        }
        logger.warn("Could not read Docker daemon CPU count from `docker info`", {
          exitCode: r.exitCode,
          stdout: r.stdout.trim().slice(0, 80),
        });
        return null;
      })
      .catch((err) => {
        logger.warn("`docker info` failed while probing daemon CPU count", {
          error: errMessage(err),
        });
        return null;
      })
      .finally(() => {
        inflightCpus = null;
      });
  }
  return inflightCpus;
}

/** Test-only: clear the memoized probe so a suite can exercise success and
 *  failure paths independently. No effect on production call paths. */
export function resetDaemonCpuCacheForTests(): void {
  cachedDaemonCpus = null;
  inflightCpus = null;
}

/**
 * The effective `--cpus` value: the host-derived budget clamped to what the
 * daemon actually has. When the daemon count is unknown, fall back to the
 * host budget (the pre-probe behavior) rather than inventing a number.
 */
export async function sandboxCpuLimit(): Promise<number> {
  const budget = sandboxCpuBudget();
  const daemonCpus = await getDaemonCpuCount();
  if (daemonCpus == null) return budget;
  return Math.max(1, Math.min(budget, daemonCpus));
}

/** Hardening flags appended to every sandbox `docker run` (ephemeral + warm). */
export async function sandboxHardeningRunArgs(): Promise<string[]> {
  return [
    "--pids-limit",
    String(SANDBOX_PIDS_LIMIT),
    "--cpus",
    String(await sandboxCpuLimit()),
    "--cap-drop",
    "ALL",
  ];
}
