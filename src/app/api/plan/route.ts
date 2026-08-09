/**
 * /api/plan — the web adapter over the dashboard-editing library
 * (narrative-compiler spec §3). GET ?csv_id returns the plan document;
 * PATCH { csv_id, mutations } applies the governed mutation grammar,
 * recompiles deterministically, persists, and returns the new spec.
 * Identical code path to the MCP edit_dashboard tool.
 */
import { apiError } from "@/app/lib/api-error";
import { editDashboard, getDashboardPlan } from "@/lib/compose/edit";
import type { PlanMutation } from "@/lib/contracts/plan";

export async function GET(request: Request) {
  try {
    const csvId = new URL(request.url).searchParams.get("csv_id");
    if (!csvId) return Response.json({ error: "csv_id required" }, { status: 400 });
    return Response.json({ plan: getDashboardPlan(csvId) ?? null });
  } catch (err) {
    return apiError("/api/plan", err, "Failed to read plan");
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      csv_id?: string;
      mutations?: PlanMutation[];
    };
    if (!body.csv_id) return Response.json({ error: "csv_id required" }, { status: 400 });
    if (!Array.isArray(body.mutations) || body.mutations.length === 0) {
      return Response.json({ error: "mutations required" }, { status: 400 });
    }
    const result = await editDashboard(body.csv_id, body.mutations);
    if (!result.ok) return Response.json({ error: result.errors.join("; ") }, { status: 422 });
    return Response.json({ ok: true, spec: result.spec, plan: result.doc });
  } catch (err) {
    return apiError("/api/plan", err, "Edit failed");
  }
}
