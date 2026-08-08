import { apiError } from "@/app/lib/api-error";
import { loadLedger } from "@/lib/learning/ledger";
import { listProposals } from "@/lib/learning/proposals";
import { listExemplars } from "@/lib/learning/exemplars";
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
    return Response.json(state);
  } catch (err) {
    return apiError("/api/learning", err, "Failed to load learning state");
  }
}
