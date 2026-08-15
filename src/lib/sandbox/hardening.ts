/**
 * Container hardening `docker run` args (finding M10). The sandbox workload is
 * non-root Python; none of these restrict a legitimate analysis, but each
 * closes a privilege/DoS avenue for injected code:
 *   --pids-limit          caps fork bombs
 *   --cpus                bounds CPU so one run can't starve the host/others
 *   --security-opt no-new-privileges  blocks setuid escalation
 *   --cap-drop ALL        the workload needs no Linux capabilities
 */
import os from "node:os";

/** Max processes/threads per sandbox container. Generous for DuckDB's thread
 *  pool + Python, tight enough to stop a fork bomb. */
export const SANDBOX_PIDS_LIMIT = 512;

/** Fraction of host cores a single sandbox may burn (leaves headroom for the
 *  Next.js server + other concurrent runs). */
export const SANDBOX_CPU_FRACTION = 0.75;

/** The CPU quota (`--cpus` value) derived from the host core count. */
export function sandboxCpuBudget(): number {
  const cores = os.cpus().length || 4;
  return Math.max(1, Math.floor(cores * SANDBOX_CPU_FRACTION));
}

/** Hardening flags appended to every sandbox `docker run` (ephemeral + warm). */
export function sandboxHardeningRunArgs(): string[] {
  return [
    "--pids-limit",
    String(SANDBOX_PIDS_LIMIT),
    "--cpus",
    String(sandboxCpuBudget()),
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
  ];
}
