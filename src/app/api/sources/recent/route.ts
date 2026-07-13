import { NextResponse } from "next/server";
import { validateLocalOrigin } from "@/lib/local-files/security";
import {
  loadRecentSources,
  renameRecentSource,
  removeRecentSource,
  clearRecentSources,
} from "@/lib/sources/recent-sources";
import { apiError } from "@/lib/api-error";

/**
 * List recent file/cloud sources (most-recent first). Returns full entries
 * including any stored cloud credentials — the client re-passes them to re-open
 * a private bucket, exactly as the warehouse presets return full configs. Both
 * are gated to the localhost origin.
 */
export async function GET(request: Request) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }
  return NextResponse.json({ sources: await loadRecentSources() });
}

export async function PATCH(request: Request) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }
  try {
    const { id, name } = await request.json();
    if (!id || typeof name !== "string") {
      return NextResponse.json({ error: "id and name are required" }, { status: 400 });
    }
    await renameRecentSource(id, name);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError("/api/sources/recent", err, "Failed to rename source");
  }
}

export async function DELETE(request: Request) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }
  try {
    const { id, all } = await request.json();
    if (all) {
      await clearRecentSources();
      return NextResponse.json({ ok: true });
    }
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
    await removeRecentSource(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError("/api/sources/recent", err, "Failed to remove source");
  }
}
