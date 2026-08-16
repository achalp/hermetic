import { NextResponse } from "next/server";
import { warmupAllSandboxes } from "@/lib/sandbox";
import { getActiveSandboxRuntime } from "@/lib/runtime-config";
import { logger, errMessage } from "@/lib/logger";

export async function POST() {
  const runtime = getActiveSandboxRuntime();
  if (runtime === "e2b") {
    return NextResponse.json({ status: "skipped", reason: "E2B uses ephemeral sandboxes" });
  }

  try {
    logger.debug("Warming up sandbox runtime...", { runtime });
    await warmupAllSandboxes();
    logger.debug("Sandbox warmup complete", { runtime });
    return NextResponse.json({ status: "ok", runtime });
  } catch (err) {
    const message = errMessage(err);
    logger.error("Sandbox warmup failed", { error: message, runtime });
    return NextResponse.json({ status: "error", error: message }, { status: 500 });
  }
}
