/**
 * /api/learning — the exemplar bank's review surface (learning retirement,
 * 2026-08-07): the runs that worked, visible and user-curated. GET lists
 * them (code included — hermetic-generated, never data values); DELETE
 * ?exemplar=<id> removes one.
 */
import { apiError } from "@/app/lib/api-error";
import { listExemplars, deleteExemplar } from "@/lib/learning/exemplars";

export async function GET() {
  try {
    const exemplars = await listExemplars();
    exemplars.sort((a, b) => (b.attempts ?? 0) - (a.attempts ?? 0));
    return Response.json({ exemplars });
  } catch (err) {
    return apiError("/api/learning", err, "Failed to load exemplars");
  }
}

export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("exemplar");
    if (!id) return Response.json({ error: "exemplar id required" }, { status: 400 });
    const ok = await deleteExemplar(id);
    return ok
      ? Response.json({ status: "deleted" })
      : Response.json({ error: "not found" }, { status: 404 });
  } catch (err) {
    return apiError("/api/learning", err, "Failed to delete exemplar");
  }
}
