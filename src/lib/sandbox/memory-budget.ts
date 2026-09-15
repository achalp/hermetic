import { run } from "./docker-utils";
import { logger, errMessage } from "@/lib/logger";
import { DEFAULT_SANDBOX_MEMORY_FRACTION } from "@/lib/constants";
import { envConfig } from "@/lib/harness-slot";
import { sandboxMemoryFraction } from "@/lib/settings";

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
  return sandboxMemoryFraction(DEFAULT_SANDBOX_MEMORY_FRACTION);
}

// A SUCCESS is cached forever (the daemon allocation is fixed for the
// process's lifetime). A FAILURE is cached for a short TTL: on a Docker-less
// machine every caller used to re-spawn `docker info` and fail again — two
// probes per wasm run, each a process spawn + 5s timeout budget — while a
// daemon started mid-session is still discovered once the TTL lapses.
export const DAEMON_PROBE_RETRY_MS = 60_000;
let cachedDaemonBytes: number | null = null;
let failedProbeAt = 0;
let inflight: Promise<number | null> | null = null;

/**
 * Total memory available to the Docker/colima DAEMON, in bytes — the VM
 * allocation on macOS, host RAM on native Linux. Returns null when it cannot be
 * determined (docker absent, `docker info` failed/timed out, unparseable).
 */
export function getDaemonMemoryBytes(): Promise<number | null> {
  if (cachedDaemonBytes != null) return Promise.resolve(cachedDaemonBytes);
  if (failedProbeAt && Date.now() - failedProbeAt < DAEMON_PROBE_RETRY_MS) {
    return Promise.resolve(null);
  }
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
        failedProbeAt = Date.now();
        return null;
      })
      .catch((err) => {
        logger.warn("`docker info` failed while probing daemon memory", {
          error: errMessage(err),
        });
        failedProbeAt = Date.now();
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
  failedProbeAt = 0;
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
  // Under the record/replay harness the label is PINNED: it is embedded in the
  // code-gen prompt (skills guidance "{{sandboxMemoryGb}}", schema block), so
  // a host-derived value makes every prompt hash machine-specific — fixtures
  // recorded on a 91 GB workstation can never replay on a 16 GB CI runner.
  // Same gating pattern as exemplar retrieval / harvest (learning loop).
  const { llmReplayConfig } = await import("@/lib/llm/replay");
  if (llmReplayConfig()) return "4.0";
  const mb = await getSandboxMemoryLimitMb();
  if (mb == null) return null;
  return (mb / 1024).toFixed(1);
}

/**
 * The wasm tier's prompt label. NOT host-derived: the browser execution
 * worker lives in a wasm32 address space (4 GB hard architectural ceiling)
 * and Pyodide's practical heap is ~2 GB regardless of machine RAM — a 64 GB
 * workstation buys the worker nothing. A CONSTANT is therefore more honest
 * than `os.totalmem()`, and it keeps the docker probe entirely off the wasm
 * path (this tier previously got NO figure at all: the docker-derived label
 * was null off-docker, so planet-scale guidance degraded to "limited RAM"
 * on exactly the tier with the least headroom).
 */
export const WASM_MEMORY_GB_LABEL = "2.0";

/**
 * The memory figure for the CODE-GEN PROMPT, runtime-aware: the wasm
 * constant on the wasm tier, the docker-daemon-derived cap elsewhere.
 * Replay-pinned to "4.0" like the docker path (host-derived prompt input).
 */
export async function getPromptMemoryGbLabel(runtime: string): Promise<string | null> {
  if (runtime === "wasm") {
    const { llmReplayConfig } = await import("@/lib/llm/replay");
    if (llmReplayConfig()) return "4.0";
    return WASM_MEMORY_GB_LABEL;
  }
  return getSandboxMemoryLimitGbLabel();
}
