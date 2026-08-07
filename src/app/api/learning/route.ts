import { apiError } from "@/app/lib/api-error";
import { loadLedger } from "@/lib/learning/ledger";
import { listProposals } from "@/lib/learning/proposals";
import { listExemplars } from "@/lib/learning/exemplars";
import { listConventionRecords, deleteConventionRecord } from "@/lib/learning/conventions";
import type { LearningState } from "@/lib/contracts/learning";

/**
 * GET /api/learning — the learning loop's review surface: ledger candidates,
 * pending/decided proposals, engine-defect findings, exemplar count. The
 * page at /learning is the human half of the loop (spec §4: durable rules
 * require approval; this is where approval happens).
 */
export async function GET() {
  try {
    const [ledger, proposals, exemplars] = await Promise.all([
      loadLedger(),
      listProposals(),
      listExemplars(),
    ]);
    const state: LearningState = {
      ledger: ledger.filter((e) => e.kind !== "engine-defect"),
      engineDefects: ledger.filter((e) => e.kind === "engine-defect"),
      proposals,
      exemplarCount: exemplars.length,
    };
    return Response.json({ ...state, conventions: listConventionRecords() });
  } catch (err) {
    return apiError("/api/learning", err, "Failed to load learning state");
  }
}

/** DELETE /api/learning?convention=<fingerprint> — manual convention curation. */
export async function DELETE(request: Request) {
  try {
    const fp = new URL(request.url).searchParams.get("convention");
    if (!fp) return Response.json({ error: "convention fingerprint required" }, { status: 400 });
    const ok = deleteConventionRecord(fp);
    return ok
      ? Response.json({ status: "deleted" })
      : Response.json({ error: "not found" }, { status: 404 });
  } catch (err) {
    return apiError("/api/learning", err, "Failed to delete conventions");
  }
}
