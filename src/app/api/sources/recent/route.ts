import { NextResponse } from "next/server";
import { validateLocalOrigin } from "@/lib/local-files/security";
import {
  loadRecentSources,
  renameRecentSource,
  removeRecentSource,
  clearRecentSources,
} from "@/lib/sources/recent-sources";
import { apiError } from "@/app/lib/api-error";
import { readJsonBody, parseBody, RecentRenameSchema, RecentDeleteSchema } from "@/lib/api-schemas";

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
    const read = await readJsonBody(request);
    if (!read.ok) return read.response;
    const parsed = parseBody(RecentRenameSchema, read.body);
    if (!parsed.ok) return parsed.response;
    await renameRecentSource(parsed.data.id, parsed.data.name);
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
    const read = await readJsonBody(request);
    if (!read.ok) return read.response;
    const parsed = parseBody(RecentDeleteSchema, read.body);
    if (!parsed.ok) return parsed.response;
    const { id, all } = parsed.data;
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
