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

  // Docker is the only runtime (E2B/microsandbox removed).
  const runtimes: RuntimeStatus[] = [
    { id: "docker", label: "Docker (Local)", available: dockerOk },
  ];

  logger.debug("Runtime availability", {
    docker: dockerOk,
    docker_daemon: dockerDaemonOk,
    docker_image: dockerImageOk,
  });

  return NextResponse.json(runtimes);
}

/** Persist the user's sandbox runtime selection (Docker only). */
export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const runtime = body.sandboxRuntime;
    if (runtime !== "docker") {
      return NextResponse.json({ error: "Invalid runtime" }, { status: 400 });
    }
    setRuntimeConfig({ sandboxRuntime: runtime });
    logger.info("Sandbox runtime changed", { runtime });
    return NextResponse.json({ status: "ok", sandboxRuntime: runtime });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
