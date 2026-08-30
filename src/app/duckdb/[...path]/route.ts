import { NextResponse, type NextRequest } from "next/server";
import { stat } from "node:fs/promises";
import { join, resolve, sep, extname } from "node:path";
import { hermeticPaths } from "@/lib/paths";
import { streamFileResponse } from "@/lib/http/file-stream";

/**
 * Serves the bundled DuckDB-WASM assets at /duckdb/* (build log D18). The WASM
 * execution worker loads the classic-worker bundle (importScripts, script-src
 * 'self'), its .wasm module (connect-src 'self'), and — critically — its EXTENSION
 * repository from here.
 *
 * Why the extension repository matters: DuckDB autoloads `parquet` (and `httpfs`
 * for ranged remote reads) from https://extensions.duckdb.org by default. Under the
 * worker's `connect-src 'self'` that fetch is correctly BLOCKED — the D18 spike
 * caught exactly this, as a sync XHR to the CDN failing with status 0. Pointing
 * `custom_extension_repository` at this same-origin route is what makes DuckDB work
 * inside the sandbox without loosening the CSP by a single byte.
 *
 * SECURITY: only files WITHIN the DuckDB asset dir are served — the joined path is
 * resolved and confirmed to stay inside the root (no `..` traversal, no absolute
 * escape). The path segments come from the URL, so this guard is load-bearing.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export async function GET(_req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const root = resolve(hermeticPaths.duckdbWasmDir());
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
  });
}
