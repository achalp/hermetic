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
    "--cap-drop",
    "ALL",
  ];
}
