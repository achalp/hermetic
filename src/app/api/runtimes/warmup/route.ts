import { NextResponse } from "next/server";
import { DEFAULT_SANDBOX_RUNTIME } from "@/lib/constants";
import { warmupSandbox } from "@/lib/sandbox/microsandbox-executor";
import { logger } from "@/lib/logger";

export async function POST() {
  if (DEFAULT_SANDBOX_RUNTIME !== "microsandbox") {
    return NextResponse.json({ status: "skipped", reason: "not using microsandbox runtime" });
  }

  try {
    logger.debug("Warming up microsandbox...");
    await warmupSandbox();
    logger.debug("Microsandbox warmup complete");
    return NextResponse.json({ status: "ok" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Microsandbox warmup failed", { error: message });
    return NextResponse.json({ status: "error", error: message }, { status: 500 });
  }
}
