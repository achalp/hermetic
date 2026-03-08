import { NextResponse } from "next/server";
import { DEFAULT_SANDBOX_RUNTIME } from "@/lib/constants";
import { warmupAllSandboxes } from "@/lib/sandbox";
import { logger } from "@/lib/logger";

export async function POST() {
  if (DEFAULT_SANDBOX_RUNTIME === "e2b") {
    return NextResponse.json({ status: "skipped", reason: "E2B uses ephemeral sandboxes" });
  }

  try {
    logger.debug("Warming up sandbox runtime...", { runtime: DEFAULT_SANDBOX_RUNTIME });
    await warmupAllSandboxes();
    logger.debug("Sandbox warmup complete", { runtime: DEFAULT_SANDBOX_RUNTIME });
    return NextResponse.json({ status: "ok", runtime: DEFAULT_SANDBOX_RUNTIME });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Sandbox warmup failed", { error: message, runtime: DEFAULT_SANDBOX_RUNTIME });
    return NextResponse.json({ status: "error", error: message }, { status: 500 });
  }
}
