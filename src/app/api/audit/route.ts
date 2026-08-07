/**
 * POST /api/audit { history_id } — on-demand non-blind audit
 * (composer-sight spec §3). Assembles the entry's DERIVED bundle (never
 * raw rows), runs one adversarial review call, persists audit.json on
 * the entry, returns the result.
 */
import { writeFileSync } from "fs";
import { join } from "path";
import { apiError } from "@/app/lib/api-error";
import { loadHistoryEntry } from "@/lib/history/storage";
import { hermeticPaths } from "@/lib/paths";
import { collectNarrativeStrings } from "@/lib/pipeline/grounding";
import { runAudit } from "@/lib/pipeline/audit";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { history_id?: string };
    const id = body.history_id;
    if (!id || !/^[a-f0-9-]{8,40}$/.test(id)) {
      return Response.json({ error: "history_id required" }, { status: 400 });
    }
    const entry = await loadHistoryEntry(id);
    const artifacts = (entry.artifacts ?? {}) as {
      results?: Record<string, unknown>;
      chart_data?: Record<string, unknown>;
      findings?: unknown;
      sql?: string;
    };
    const result = await runAudit({
      question: entry.meta.question,
      results: artifacts.results,
      chartData: artifacts.chart_data,
      findings: artifacts.findings,
      narrativeTexts: collectNarrativeStrings(entry.spec),
      sql: artifacts.sql,
    });
    if (!result) {
      return Response.json({ error: "Audit failed — see server logs" }, { status: 502 });
    }
    try {
      writeFileSync(
        join(hermeticPaths.historyDir(), id, "audit.json"),
        JSON.stringify(result, null, 2),
        "utf-8"
      );
    } catch {
      // Persistence is best-effort; the caller still gets the result.
    }
    return Response.json({ audit: result });
  } catch (err) {
    return apiError("/api/audit", err, "Audit failed");
  }
}
