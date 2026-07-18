import { NextResponse } from "next/server";
import { validateLocalOrigin } from "@/lib/local-files/security";
import { getStoredCSV } from "@/lib/csv/storage";

/**
 * Return the stored schema for a csvId. Used when reattaching to a run whose
 * live view was lost (page reload): the source is still in the store — pinned
 * alive by its in-flight run (see csv/storage isExpired) — so the client can
 * restore the source context without re-uploading or re-browsing.
 */
export function GET(request: Request) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }
  const csvId = new URL(request.url).searchParams.get("csvId");
  if (!csvId) {
    return NextResponse.json({ error: "csvId is required" }, { status: 400 });
  }
  const stored = getStoredCSV(csvId);
  if (!stored) {
    return NextResponse.json({ error: "Source not found or expired" }, { status: 404 });
  }
  return NextResponse.json({ csv_id: csvId, schema: stored.schema });
}
