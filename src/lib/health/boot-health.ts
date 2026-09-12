/**
 * Boot-time configuration health check (finding PE-4). The operator's first
 * signal that the environment is misconfigured used to be the FIRST analysis
 * failing mid-run with a cryptic connection error — maximally far from its
 * cause. This runs once at server start and WARNS (never blocks, never throws)
 * when a prerequisite the active configuration NEEDS is missing.
 *
 * Every check keys on the ACTIVE runtime/provider so it can't cry wolf: it never
 * warns about Docker when the user runs on E2B, nor about an API key when the
 * active provider needs none. A check only fires when the very next analysis
 * would fail for that reason, so an empty log is a genuine all-clear.
 */
import { logger, errMessage } from "@/lib/logger";
import { getRuntimeConfig, setRuntimeConfig } from "@/lib/runtime-config";
import { envConfig } from "@/lib/harness-slot";
import { getActiveProvider } from "@/lib/llm/client";
import { run } from "@/lib/sandbox/docker-utils";

/** True when the Docker daemon answers `docker info` (exit 0) within the budget. */
async function dockerDaemonReachable(): Promise<boolean> {
  const res = await run("docker", ["info", "--format", "{{.ServerVersion}}"], {
    timeoutMs: 5_000,
  }).catch(() => null);
  return !!res && res.exitCode === 0;
}

/**
 * Sandbox prerequisite — and the place the runtime CHOICE gets its input.
 *
 * The probe is recorded, not just logged: `resolveActiveRuntime` prefers Docker
 * whenever `dockerAvailable` is not false, so on a machine with no daemon that
 * value is the difference between falling back to wasm and resolving to docker
 * and failing the first analysis. The desktop app has no other prober.
 *
 * The warning is RUNTIME-AWARE. It used to fire unconditionally, on the premise
 * that "Docker is the only runtime" — untrue since the wasm tier shipped, and
 * the packaged desktop app (which runs wasm and has no Docker) announced
 * "analyses will fail until Docker is running" on every single launch. A warning
 * that is wrong every time teaches people to ignore the ones that are right.
 */
async function checkSandbox(): Promise<void> {
  const reachable = await dockerDaemonReachable();
  // Record BEFORE reading the active runtime: the resolution below depends on it.
  try {
    setRuntimeConfig({ dockerAvailable: reachable });
  } catch (err) {
    logger.warn("boot health: could not persist docker availability", {
      error: errMessage(err),
    });
  }
  if (reachable) {
    logger.info("boot health: Docker daemon reachable");
    return;
  }
  // Warn on INTENT, not on the resolved runtime. Persisting dockerAvailable:false
  // above makes resolveActiveRuntime answer "wasm", so keying the warning off the
  // ACTIVE runtime made it unreachable in the very case it exists for: a web user
  // whose daemon is merely stopped would be moved to a different engine in
  // silence. Intent is an explicit pin, or — on a channel with no wasm fallback
  // configured (the web path) — the absence of one, where Docker is the norm.
  const pinned = getRuntimeConfig().sandboxRuntime;
  const channelFallback = envConfig().HERMETIC_DEFAULT_RUNTIME;
  const expectedDocker = pinned === "docker" || (!pinned && channelFallback !== "wasm");
  if (expectedDocker) {
    logger.warn(
      "boot health: the Docker daemon is not reachable — analyses will fail until Docker is running"
    );
  } else {
    logger.info("boot health: no Docker daemon; analyses run on the built-in engine (wasm)");
  }
}

/**
 * LLM provider prerequisite. getActiveProvider() already runs the full detection
 * (keyed vars, ADC, AWS creds, claude CLI) and THROWS a detailed message when
 * nothing is configured — the exact failure the first analysis would hit — so a
 * catch here surfaces it at boot instead of mid-run.
 */
function checkProvider(): void {
  try {
    logger.info("boot health: LLM provider configured", { provider: getActiveProvider() });
  } catch {
    logger.warn(
      "boot health: no LLM provider is configured — set an API key or enable a local backend in " +
        "Settings before running an analysis"
    );
  }
}

/** Run all boot health checks. Never throws — health logging must not affect boot. */
export async function logBootHealth(): Promise<void> {
  try {
    checkProvider();
    await checkSandbox();
  } catch (err) {
    logger.debug("boot health check errored (ignored)", { error: errMessage(err) });
  }
}
