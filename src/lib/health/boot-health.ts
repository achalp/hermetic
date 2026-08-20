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
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import { getActiveProvider } from "@/lib/llm/client";
import { getApiKey } from "@/lib/secrets";
import { run } from "@/lib/sandbox/docker-utils";

/** True when the Docker daemon answers `docker info` (exit 0) within the budget. */
async function dockerDaemonReachable(): Promise<boolean> {
  const res = await run("docker", ["info", "--format", "{{.ServerVersion}}"], {
    timeoutMs: 5_000,
  }).catch(() => null);
  return !!res && res.exitCode === 0;
}

/**
 * Sandbox prerequisite for the ACTIVE runtime:
 *  - docker        → the daemon must be reachable (installed-but-not-running is
 *                    the classic silent failure the UI can't catch);
 *  - e2b           → E2B is a cloud service, so it definitively needs its key;
 *  - microsandbox  → self-hostable, so a missing key is NOT necessarily a
 *                    misconfig — only note which runtime is active (no warn).
 */
async function checkSandbox(): Promise<void> {
  const rt = getActiveSandboxRuntime();
  if (rt === "docker") {
    if (await dockerDaemonReachable()) {
      logger.info("boot health: Docker daemon reachable");
    } else {
      logger.warn(
        "boot health: the active sandbox runtime is Docker, but the Docker daemon is not reachable " +
          "— analyses will fail until Docker is running (or switch the runtime in Settings)"
      );
    }
    return;
  }
  if (rt === "e2b" && !getApiKey("e2b")) {
    logger.warn(
      "boot health: the active sandbox runtime is E2B, but no E2B API key is configured — " +
        "analyses will fail until it is set in Settings (or switch the runtime)"
    );
    return;
  }
  logger.info("boot health: sandbox runtime", { runtime: rt });
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
