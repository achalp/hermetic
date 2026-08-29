import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { logger } from "@/lib/logger";
import { DOCKER_SANDBOX_IMAGE } from "@/lib/constants";
import { setRuntimeConfig } from "@/lib/runtime-config";

interface RuntimeStatus {
  id: string;
  label: string;
  available: boolean;
}

function checkDocker(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("docker", ["info"], { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

function checkDockerImage(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("docker", ["image", "inspect", DOCKER_SANDBOX_IMAGE], { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
}

export async function GET() {
  const dockerDaemonOk = await checkDocker();
  const dockerImageOk = dockerDaemonOk ? await checkDockerImage() : false;
  const dockerOk = dockerDaemonOk && dockerImageOk;

  // Persist the probe so getActiveSandboxRuntime() can auto-fall-back to the
  // browser-sandbox `wasm` runtime on a machine with no Docker (§11 / build log).
  setRuntimeConfig({ dockerAvailable: dockerOk });

  const runtimes: RuntimeStatus[] = [
    { id: "docker", label: "Docker (Local)", available: dockerOk },
    // The WASM runtime runs in the browser worker (Pyodide + DuckDB-WASM) — it needs
    // NO Docker and works in the web app AND the desktop app, so it is ALWAYS a valid
    // choice, not just a Docker-absent fallback (build log D17). When Docker is absent
    // it's also the auto-default (getActiveSandboxRuntime).
    { id: "wasm", label: "Built-in (WASM · no Docker)", available: true },
  ];

  logger.debug("Runtime availability", {
    docker: dockerOk,
    docker_daemon: dockerDaemonOk,
    docker_image: dockerImageOk,
    wasm_fallback: !dockerOk,
  });

  return NextResponse.json(runtimes);
}

/** Persist the user's sandbox runtime selection (Docker or the built-in WASM runtime). */
export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const runtime = body.sandboxRuntime;
    if (runtime !== "docker" && runtime !== "wasm") {
      return NextResponse.json({ error: "Invalid runtime" }, { status: 400 });
    }
    setRuntimeConfig({ sandboxRuntime: runtime });
    logger.info("Sandbox runtime changed", { runtime });
    return NextResponse.json({ status: "ok", sandboxRuntime: runtime });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
