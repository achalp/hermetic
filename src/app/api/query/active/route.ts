import { NextResponse } from "next/server";
import { validateLocalOrigin } from "@/lib/local-files/security";
import { findActiveRunForCsv, listActiveRuns } from "@/lib/pipeline/run-stream-hub";

/**
 * Discover analyses still running server-side (they survive a client drop —
 * see patch-stream / run-stream-hub). With `?csvId=` returns the most recent
 * run for that source; without it, all active runs. The client polls this on
 * mount to offer a "reattach" to a run whose live view was lost (reload / HMR).
 */
export function GET(request: Request) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }
  const csvId = new URL(request.url).searchParams.get("csvId");
  if (csvId) {
    return NextResponse.json({ run: findActiveRunForCsv(csvId) });
  }
  return NextResponse.json({ runs: listActiveRuns() });
}
