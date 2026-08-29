import { NextResponse, type NextRequest } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { getInputRegistry } from "@/lib/sandbox/wasm/input-singleton";
import { logger } from "@/lib/logger";

/**
 * GET /api/wasm-input/<token> — streams a host-materialized data file into the
 * CSP-locked worker (build log D11, delivery option B). The worker fetches this
 * same-origin URL (allowed by connect-src 'self') and writes the bytes to its FS.
 *
 * SECURITY: the worker holds a TOKEN (an unguessable crypto UUID the sidecar
 * minted), never a path. The endpoint serves ONLY the file that token was
 * registered for — so untrusted worker code cannot read arbitrary host files
 * (no path input, no traversal, no guessing). Unknown/released token → 404.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const hostPath = getInputRegistry().resolve(token);
  if (!hostPath) {
    logger.debug("wasm-input: unknown token", { token });
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // The path came from the trusted sidecar (register()), but confirm it's a real
  // file before streaming — a released/rotated temp file must 404, not 500.
  let size: number;
  try {
    const s = await stat(hostPath);
    if (!s.isFile()) throw new Error("not a file");
    size = s.size;
  } catch {
    return NextResponse.json({ error: "gone" }, { status: 404 });
  }

  const web = Readable.toWeb(createReadStream(hostPath)) as WebReadableStream<Uint8Array>;
  return new NextResponse(web as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(size),
      "cache-control": "no-store",
    },
  });
}
