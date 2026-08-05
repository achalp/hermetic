import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { resolve } from "node:path";
import { apiError } from "@/app/lib/api-error";
import { listDirectory, getHomePath } from "@/lib/local-files/browser";
import {
  validateLocalOrigin,
  isPathAllowed,
  PATH_NOT_ALLOWED_ERROR,
} from "@/lib/local-files/security";

export async function GET(request: NextRequest) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }

  const searchParams = request.nextUrl.searchParams;
  const rawPath = searchParams.get("path") || getHomePath();

  // Resolve to absolute path (handles .. segments)
  const dirPath = resolve(rawPath);

  // Root-jail: resolve() normalizes but does not confine — without this any
  // absolute path (/etc, another user's home) was listable.
  if (!isPathAllowed(dirPath)) {
    return NextResponse.json({ error: PATH_NOT_ALLOWED_ERROR }, { status: 403 });
  }

  try {
    const entries = await listDirectory(dirPath);
    return NextResponse.json({ path: dirPath, entries });
  } catch (err) {
    return apiError("/api/local-files/browse", err, "Failed to read directory", 400);
  }
}
