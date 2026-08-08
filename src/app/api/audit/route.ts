/**
 * /api/audit — on-demand non-blind audit (composer-sight spec §3).
 * POST { history_id } runs it; GET ?history_id returns the persisted one.
 */
import { apiError } from "@/app/lib/api-error";
import { loadHistoryAudit } from "@/lib/history/storage";
import { auditHistoryEntry } from "@/lib/pipeline/audit";

const ID_RE = /^[a-f0-9-]{8,40}$/;

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { history_id?: string };
    if (!body.history_id || !ID_RE.test(body.history_id)) {
      return Response.json({ error: "history_id required" }, { status: 400 });
    }
    const result = await auditHistoryEntry(body.history_id);
    if (!result) return Response.json({ error: "Audit failed — see server logs" }, { status: 502 });
    return Response.json({ audit: result });
  } catch (err) {
    return apiError("/api/audit", err, "Audit failed");
  }
}

export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("history_id");
    if (!id || !ID_RE.test(id)) {
      return Response.json({ error: "history_id required" }, { status: 400 });
    }
    try {
      return Response.json({ audit: (await loadHistoryAudit(id)) ?? null });
    } catch {
      return Response.json({ audit: null });
    }
  } catch (err) {
    return apiError("/api/audit", err, "Failed to read audit");
  }
}
