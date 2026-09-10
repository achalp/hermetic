/**
 * Liveness/readiness probe. Deliberately dependency-light: version from
 * package.json, the configured sandbox runtime, and — for docker — whether
 * the daemon answers `docker info` (the same bounded probe the runtimes
 * route uses, kept local so this never imports sandbox internals). No LLM
 * or warehouse calls: health must stay cheap enough to poll.
 */
import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import { hermeticPaths } from "@/lib/paths";
import { version } from "../../../../package.json";

/**
 * The desktop shell writes update-pending.json after installing an
 * auto-update (applied on relaunch) and deletes it on boot. Read-and-catch
 * (never exists-then-read); a missing/unreadable file simply means no
 * pending update — the common case everywhere but a not-yet-restarted app.
 */
function pendingUpdateVersion(): string | null {
  try {
    const parsed = JSON.parse(readFileSync(hermeticPaths.updatePendingFile(), "utf8")) as {
      version?: string;
    };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function dockerDaemonResponds(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("docker", ["info"], { timeout: 5000 }, (err) => resolve(!err));
  });
}

export async function GET() {
  const sandboxRuntime = getActiveSandboxRuntime();
  // Only docker has a cheap local daemon probe; e2b/microsandbox liveness
  // needs network calls (see /api/runtimes) — a health endpoint reports
  // their configuration, not their reachability.
  const dockerDaemon = sandboxRuntime === "docker" ? await dockerDaemonResponds() : undefined;
  return NextResponse.json({
    status: "ok",
    version,
    update_pending: pendingUpdateVersion(),
    sandbox: {
      runtime: sandboxRuntime,
      ...(dockerDaemon !== undefined ? { docker_daemon: dockerDaemon } : {}),
    },
  });
}
