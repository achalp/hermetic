/**
 * /api/plan — the web adapter over the dashboard-editing library
 * (narrative-compiler spec §3). GET ?csv_id returns the plan document;
 * PATCH { csv_id, mutations } applies the governed mutation grammar,
 * recompiles deterministically, persists, and returns the new spec.
 * Identical code path to the MCP edit_dashboard tool.
 */
import { apiError } from "@/app/lib/api-error";
import { editDashboard, getEditSurface } from "@/lib/compose/edit";
import { readJsonBody, parseBody, PlanEditSchema } from "@/lib/api-schemas";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const csvId = url.searchParams.get("csv_id");
    if (!csvId) return Response.json({ error: "csv_id required" }, { status: 400 });
    // The full edit surface (sections in effective order, un-narrated
    // claims, view catalog with reasons) — the plan doc rides inside it.
    // history_id keys restored analyses (their csvId is freshly minted at
    // restore and maps to no record).
    const surface = await getEditSurface(csvId, url.searchParams.get("history_id"));
    return Response.json({ plan: surface?.doc ?? null, surface });
  } catch (err) {
    return apiError("/api/plan", err, "Failed to read plan");
  }
}

export async function PATCH(request: Request) {
  try {
    const read = await readJsonBody(request);
    if (!read.ok) return read.response;
    const parsed = parseBody(PlanEditSchema, read.body);
    if (!parsed.ok) return parsed.response;
    const { csv_id, history_id, mutations } = parsed.data;
    const result = await editDashboard(csv_id, mutations, history_id);
    if (!result.ok) return Response.json({ error: result.errors.join("; ") }, { status: 422 });
    return Response.json({ ok: true, spec: result.spec, plan: result.doc });
  } catch (err) {
    return apiError("/api/plan", err, "Edit failed");
  }
}
