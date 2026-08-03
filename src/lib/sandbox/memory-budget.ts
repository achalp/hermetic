import { run } from "./docker-utils";
import { logger } from "@/lib/logger";
import { DEFAULT_SANDBOX_MEMORY_FRACTION } from "@/lib/constants";
import { envConfig } from "@/lib/harness-slot";

/**
 * Per-container memory budget, derived at runtime from the Docker daemon's own
 * allocation — never a hardcoded byte count and never the host OS total.
 *
 * WHY the daemon and not the host: on macOS the sandbox runs inside a VM
 * (colima or Docker Desktop) whose RAM is a FIXED slice of the Mac — e.g. a
 * 16 GB Mac may give the VM only ~4 GB. `os.totalmem()` would report 16 GB and
 * a container capped near that would be OOM-killed the moment it crossed the
 * ~4 GB VM ceiling. `docker info`'s MemTotal is the DAEMON's view — the VM
 * allocation on macOS, host RAM on native Linux — so it is the only correct
 * ceiling in both deployments.
 */

/** Policy fraction of daemon memory a container may use (env-overridable). */
function memoryFraction(): number {
  const raw = Number(envConfig().SANDBOX_MEMORY_FRACTION);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : DEFAULT_SANDBOX_MEMORY_FRACTION;
}

// Cache only a SUCCESSFUL probe: the daemon allocation is fixed for the
// process's lifetime, but a transient `docker info` failure must not poison the
// value forever, so a null result is not cached and a later call retries.
let cachedDaemonBytes: number | null = null;
let inflight: Promise<number | null> | null = null;

/**
 * Total memory available to the Docker/colima DAEMON, in bytes — the VM
 * allocation on macOS, host RAM on native Linux. Returns null when it cannot be
 * determined (docker absent, `docker info` failed/timed out, unparseable).
 */
export function getDaemonMemoryBytes(): Promise<number | null> {
  if (cachedDaemonBytes != null) return Promise.resolve(cachedDaemonBytes);
  if (!inflight) {
    inflight = run("docker", ["info", "--format", "{{.MemTotal}}"], { timeoutMs: 5_000 })
      .then((r) => {
        const bytes = parseInt(r.stdout.trim(), 10);
        if (r.exitCode === 0 && Number.isFinite(bytes) && bytes > 0) {
          cachedDaemonBytes = bytes;
          return bytes;
        }
        logger.warn("Could not read Docker daemon memory from `docker info`", {
          exitCode: r.exitCode,
          stdout: r.stdout.trim().slice(0, 80),
        });
        return null;
      })
      .catch((err) => {
        logger.warn("`docker info` failed while probing daemon memory", {
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Test-only: clear the memoized probe so a suite can exercise success and
 *  failure paths independently. No effect on production call paths. */
export function resetDaemonMemoryCacheForTests(): void {
  cachedDaemonBytes = null;
  inflight = null;
}

/**
 * Per-container memory cap in whole MB, or null when the daemon allocation is
 * unknown (caller then omits `--memory` rather than inventing a number).
 */
export async function getSandboxMemoryLimitMb(): Promise<number | null> {
  const bytes = await getDaemonMemoryBytes();
  if (bytes == null) return null;
  return Math.floor((bytes * memoryFraction()) / (1024 * 1024));
}

/**
 * `docker run` args that enforce the derived cap: `--memory` plus a matching
 * `--memory-swap` so swap can't mask an overrun (making the ceiling a true RAM
 * limit and a clean OOM-kill at the cap). Empty when the cap is unknown — the
 * container then runs uncapped exactly as before, so this is strictly additive.
 */
export async function sandboxMemoryRunArgs(): Promise<string[]> {
  const mb = await getSandboxMemoryLimitMb();
  if (mb == null) return [];
  return ["--memory", `${mb}m`, "--memory-swap", `${mb}m`];
}

/**
 * The derived cap as a human GB label for the code-gen prompt (e.g. "3.0"), so
 * the model plans against the SAME limit the container enforces. null when
 * unknown — the prompt then omits a specific figure rather than stating a
 * fabricated one.
 */
export async function getSandboxMemoryLimitGbLabel(): Promise<string | null> {
  const mb = await getSandboxMemoryLimitMb();
  if (mb == null) return null;
  return (mb / 1024).toFixed(1);
}
