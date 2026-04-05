import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { resolve } from "node:path";
import { listDirectory, getHomePath } from "@/lib/local-files/browser";
import { validateLocalOrigin } from "@/lib/local-files/security";

export async function GET(request: NextRequest) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }

  const searchParams = request.nextUrl.searchParams;
  const rawPath = searchParams.get("path") || getHomePath();

  // Resolve to absolute path (handles .. segments)
  const dirPath = resolve(rawPath);

  try {
    const entries = await listDirectory(dirPath);
    return NextResponse.json({ path: dirPath, entries });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to read directory";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
