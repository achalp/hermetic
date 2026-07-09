/**
 * Dev-only transport probe (diagnosing "network error" on long streams).
 *
 * Streams a timestamped tick every 15s (same cadence and headers as the
 * patch-stream keepalive) for up to 25 minutes, and logs when/if the client
 * aborts. Lets us test the browser → dev-proxy → app-server chain with a
 * long-lived stream WITHOUT burning an LLM/sandbox run: if `curl -N` and a
 * browser tab both survive 25 min, the transport is exonerated and the
 * mid-run "TypeError: network error" failures are environmental (sleep,
 * network change); if either dies early, the elapsed time fingerprints
 * which wall was hit.
 */
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const TICK_MS = 15_000;
const MAX_MS = 25 * 60 * 1000;

export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return new Response("dev only", { status: 404 });
  }
  const started = Date.now();
  const encoder = new TextEncoder();
  logger.info("[stream-probe] started");

  const stream = new ReadableStream({
    start(controller) {
      const finish = (why: string) => {
        clearInterval(iv);
        logger.info(`[stream-probe] ${why}`, {
          elapsedS: Math.round((Date.now() - started) / 1000),
        });
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const iv = setInterval(() => {
        const elapsed = Date.now() - started;
        try {
          controller.enqueue(
            encoder.encode(`tick ${new Date().toISOString()} +${Math.round(elapsed / 1000)}s\n`)
          );
        } catch {
          finish("enqueue failed (client gone)");
          return;
        }
        if (elapsed >= MAX_MS) finish("completed 25min");
      }, TICK_MS);
      request.signal.addEventListener("abort", () => finish("client aborted"));
      controller.enqueue(encoder.encode(`probe start ${new Date().toISOString()}\n`));
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
