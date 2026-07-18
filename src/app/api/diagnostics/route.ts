/**
 * Run-diagnostics reader — surfaces the per-run JSONL records (stages,
 * escalations, retries, materialization, per-step wall times, cost) that
 * previously required shell jq archaeology to inspect. Mirrors /api/cost.
 */
import { listRunDiagnostics } from "@/lib/diagnostics/run-diagnostics";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const runs = await listRunDiagnostics(limit);
  return Response.json({ runs });
}
