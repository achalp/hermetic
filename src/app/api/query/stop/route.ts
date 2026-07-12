import { NextResponse } from "next/server";
import { validateLocalOrigin } from "@/lib/local-files/security";
import { stopRun } from "@/lib/pipeline/run-control";
import { apiError } from "@/lib/api-error";

/**
 * Stop an in-flight analysis on demand — the user's cancel button. A SEPARATE
 * request from the streaming one, so it reaches the run only through the
 * run-control registry (keyed by runId). Aborts the run's signal (unwinding
 * LLM streams / warehouse polling) and force-removes its sandbox containers.
 */
export async function POST(request: Request) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as { runId?: unknown };
    const runId = typeof body.runId === "string" ? body.runId : "";
    if (!runId) {
      return NextResponse.json({ error: "runId is required" }, { status: 400 });
    }
    const stopped = await stopRun(runId);
    // `false` = the run already finished (or never existed) — not an error.
    return NextResponse.json({ stopped });
  } catch (err) {
    return apiError("/api/query/stop", err, "Failed to stop the analysis");
  }
}
