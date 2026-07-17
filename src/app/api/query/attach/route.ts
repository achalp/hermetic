import { NextResponse } from "next/server";
import { validateLocalOrigin } from "@/lib/local-files/security";
import { PATCH_STREAM_HEADERS } from "@/lib/pipeline/patch-stream";
import { hasRunChannel, subscribeRunChannel } from "@/lib/pipeline/run-stream-hub";

/**
 * Reattach to a run that is still executing server-side and stream its output
 * as if the client had been connected all along: the full patch buffer so far
 * is replayed, then every subsequent line live, then the stream closes when the
 * run ends. Emits the SAME NDJSON patch protocol as /api/query, so the client's
 * existing useUIStream consumer handles it unchanged (POST with the useUIStream
 * body shape; the runId travels in `context.runId`).
 *
 * 404 when the run is unknown (never existed, or its post-completion grace
 * window elapsed) — the client then falls back to loading it from history.
 */
export async function POST(request: Request) {
  if (!validateLocalOrigin(request)) {
    return NextResponse.json({ error: "Local access only" }, { status: 403 });
  }

  let runId: string | undefined;
  try {
    const body = await request.json();
    runId = body?.context?.runId ?? body?.runId;
  } catch {
    // fall through to the missing-id error
  }
  if (!runId) {
    return NextResponse.json({ error: "runId is required" }, { status: 400 });
  }
  if (!hasRunChannel(runId)) {
    return NextResponse.json({ error: "No such active run" }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      const unsubscribe = subscribeRunChannel(runId!, (line) => {
        if (line === null) {
          // Run ended — flush is done, close this reattached stream.
          close();
          return;
        }
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(line));
        } catch {
          closed = true;
        }
      });

      // Raced to close between hasRunChannel and subscribe → nothing to stream.
      if (!unsubscribe) {
        close();
        return;
      }

      // This reattached client disconnected → stop delivering to it (the run
      // itself keeps going for anyone else / its own history save).
      try {
        request.signal.addEventListener("abort", () => {
          unsubscribe();
          close();
        });
      } catch {
        /* signal unavailable — non-fatal */
      }
    },
  });

  return new Response(stream, { status: 200, headers: PATCH_STREAM_HEADERS });
}
