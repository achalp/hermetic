/**
 * Liveness/readiness probe. Deliberately dependency-light: version from
 * package.json, the configured sandbox runtime, and — for docker — whether
 * the daemon answers `docker info` (the same bounded probe the runtimes
 * route uses, kept local so this never imports sandbox internals). No LLM
 * or warehouse calls: health must stay cheap enough to poll.
 */
import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import { version } from "../../../../package.json";

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
    sandbox: {
      runtime: sandboxRuntime,
      ...(dockerDaemon !== undefined ? { docker_daemon: dockerDaemon } : {}),
    },
  });
}
