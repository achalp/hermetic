import { NextResponse, type NextRequest } from "next/server";
import { stat } from "node:fs/promises";
import { join, resolve, sep, extname } from "node:path";
import { hermeticPaths } from "@/lib/paths";
import { streamFileResponse } from "@/lib/http/file-stream";

/**
 * Serves the bundled Pyodide distribution at /pyodide/* (build log D15). The WASM
 * execution worker loads pyodide.js (importScripts, script-src 'self') and fetches
 * its .wasm / stdlib / wheels (connect-src 'self') from here — all SAME-ORIGIN, which
 * is exactly what the D8=self worker CSP allows. Without this route the wasm runtime
 * cannot boot in the running app (dev or packaged).
 *
 * SECURITY: only files WITHIN the Pyodide dir are served — the joined path is
 * resolved and confirmed to stay inside the root (no `..` traversal, no absolute
 * escape). The path segments come from the URL, so this guard is load-bearing.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".zip": "application/zip",
  ".whl": "application/octet-stream",
  ".data": "application/octet-stream",
  ".ts": "application/octet-stream", // .d.ts etc. — never executed here
  ".map": "application/json; charset=utf-8",
};

export async function GET(_req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const root = resolve(hermeticPaths.pyodideDir());
  const target = resolve(join(root, ...(path ?? [])));

  // Path-traversal guard: the resolved target must stay inside root.
  if (target !== root && !target.startsWith(root + sep)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let size: number;
  try {
    const s = await stat(target);
    if (!s.isFile()) throw new Error("not a file");
    size = s.size;
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return streamFileResponse(target, {
    contentType: CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
    size,
    // Pyodide assets are content-addressed by version — cache aggressively.
    cacheControl: "public, max-age=31536000, immutable",
  });
}
