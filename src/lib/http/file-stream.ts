import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

/**
 * Stream a host file as a standard `Response` body (a Next route handler may return
 * one). Centralizes the single Node→web stream cast (`Readable.toWeb` yields a
 * node/stream/web type that isn't structurally a DOM `BodyInit`) so route handlers
 * don't each carry the double-cast. Framework-free — used by the WASM asset/input
 * routes (build log D15). Returns a global `Response`, never NextResponse, so this
 * stays in src/lib (no next/server import).
 */
export function streamFileResponse(
  path: string,
  opts: { contentType: string; size: number; cacheControl?: string }
): Response {
  const web = Readable.toWeb(createReadStream(path)) as WebReadableStream<Uint8Array>;
  return new Response(web as unknown as BodyInit, {
    status: 200,
    headers: {
      "content-type": opts.contentType,
      "content-length": String(opts.size),
      ...(opts.cacheControl ? { "cache-control": opts.cacheControl } : {}),
    },
  });
}
