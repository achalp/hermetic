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

async function checkMicrosandbox(): Promise<boolean> {
  const url = process.env.MICROSANDBOX_URL || "http://127.0.0.1:5555";
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    // Any response (even 404) means the server is up
    return res.status > 0;
  } catch {
    return false;
  }
}

function checkE2B(): boolean {
  return !!process.env.E2B_API_KEY;
}

export async function GET() {
  const [dockerDaemonOk, msbOk] = await Promise.all([checkDocker(), checkMicrosandbox()]);
  const dockerImageOk = dockerDaemonOk ? await checkDockerImage() : false;
  const dockerOk = dockerDaemonOk && dockerImageOk;
  const e2bOk = checkE2B();

  const runtimes: RuntimeStatus[] = [
    { id: "docker", label: "Docker (Local)", available: dockerOk },
    { id: "microsandbox", label: "Microsandbox (MicroVM)", available: msbOk },
    { id: "e2b", label: "E2B (Cloud)", available: e2bOk },
  ];

  logger.debug("Runtime availability", {
    docker: dockerOk,
    docker_daemon: dockerDaemonOk,
    docker_image: dockerImageOk,
    microsandbox: msbOk,
    e2b: e2bOk,
  });

  return NextResponse.json(runtimes);
}

/** Persist the user's sandbox runtime selection */
export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const runtime = body.sandboxRuntime;
    if (!["docker", "e2b", "microsandbox"].includes(runtime)) {
      return NextResponse.json({ error: "Invalid runtime" }, { status: 400 });
    }
    setRuntimeConfig({ sandboxRuntime: runtime });
    logger.info("Sandbox runtime changed", { runtime });
    return NextResponse.json({ status: "ok", sandboxRuntime: runtime });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
