import { NextResponse, type NextRequest } from "next/server";
import { validateLocalOrigin } from "@/lib/local-files/security";
import { getManifestStore } from "@/lib/manifest/store";
import { manifestView, entityDetail } from "@/lib/manifest/view";
import { getStoredCSV } from "@/lib/csv/storage";
import { apiError } from "@/app/lib/api-error";

/**
 * Read a connected manifest: the entity-list view, or — with `?entity=<name>` —
 * one entity's detail (full schema + sample rows + manifest docs) for the
 * browser's detail pane. Reads only; the store is written by connect/attach.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!validateLocalOrigin(req)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }
  try {
    const { id } = await ctx.params;
    const record = getManifestStore().get(id);
    if (!record) {
      return NextResponse.json({ error: "unknown manifest" }, { status: 404 });
    }
    const entity = req.nextUrl.searchParams.get("entity");
    if (entity === null) return NextResponse.json(manifestView(record));

    const detail = entityDetail(record, entity, (csvId) => getStoredCSV(csvId)?.schema);
    if (!detail) return NextResponse.json({ error: "unknown entity" }, { status: 404 });
    return NextResponse.json(detail);
  } catch (err) {
    return apiError("/api/manifest/[id]", err, "Failed to read that manifest");
  }
}
