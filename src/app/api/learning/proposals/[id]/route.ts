import { z } from "zod";
import { apiError } from "@/app/lib/api-error";
import { acceptProposal, rejectProposal } from "@/lib/learning/proposals";

const BodySchema = z.object({ action: z.enum(["accept", "reject"]) });

/**
 * POST /api/learning/proposals/:id — the approval click. Accept writes (or
 * appends to) the user-level complement skill at
 * data/skills/<parent>-learned/SKILL.md — never a shipped built-in — and the
 * skill hot-reloads on the next question. Reject is remembered by the
 * ledger fingerprint: the same lesson will not re-propose.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const body = BodySchema.safeParse(await request.json().catch(() => null));
    if (!body.success) {
      return Response.json({ error: "Body must be {action: accept|reject}" }, { status: 400 });
    }
    if (body.data.action === "accept") {
      const { applied, path } = await acceptProposal(id);
      return Response.json({ ok: true, applied, path });
    }
    await rejectProposal(id);
    return Response.json({ ok: true, applied: false });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("No proposal")) {
      return Response.json({ error: err.message }, { status: 404 });
    }
    return apiError("/api/learning/proposals/[id]", err, "Failed to decide proposal");
  }
}
