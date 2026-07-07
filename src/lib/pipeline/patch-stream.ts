/**
 * Shared NDJSON patch-stream scaffold for the Ask and Investigate routes.
 *
 * Both routes stream JSONL spec patches with the same protocol: an initial
 * wholesale `/state` add carrying `__progress`, followed by
 * `replace /state/__progress` updates, `: keepalive` comment lines every 15s
 * (so buffering proxies and browsers don't idle-drop the socket during long
 * sandbox/LLM phases), and a canonical anti-buffering header set.
 *
 * History: this scaffold used to be hand-rolled in each route and drifted —
 * Investigate fixed the "keying the wholesale add on step === 1 clobbers
 * sibling state (__warehouse_csv_id)" bug while Ask kept it; Ask gained the
 * `no-transform` proxy-buffering fix while Investigate lacked it; and the two
 * declared different Content-Types for the same protocol. It lives here now
 * so the streaming contract exists exactly once.
 */
import { logger } from "@/lib/logger";

/**
 * Canonical headers for the patch stream. `no-cache, no-transform` +
 * `X-Accel-Buffering: no` keep buffering reverse proxies (nginx and friends)
 * from holding the keepalives until the run finishes — without them a long
 * run sends nothing to the browser for minutes and the proxy drops the
 * socket (~130s), surfacing as a mid-analysis "network error".
 */
export const PATCH_STREAM_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
} as const;

const KEEPALIVE_INTERVAL_MS = 15_000;

export interface PatchStream {
  /** Emit a raw line (caller includes the trailing newline). */
  emit(data: string): void;
  /**
   * Emit a `__progress` state patch. The wholesale `/state` add happens
   * exactly ONCE (the first patch); afterwards only `/state/__progress` is
   * replaced. Keying the wholesale add on `step === 1` instead clobbered
   * sibling state: the warehouse path emits several step-1 stages, and the
   * later ones wiped `__warehouse_csv_id`.
   */
  emitProgress(stage: string, step: number, total: number): void;
  /** Whether the client has disconnected (enqueue failed). */
  isClosed(): boolean;
  /**
   * Every emitted line, including after the client disconnected. Lets the
   * route assemble the final spec server-side and persist history for a
   * client that dropped mid-analysis — the run already happened; this stops
   * it being wasted.
   */
  emittedLines: string[];
}

/**
 * Build the streaming Response for a query route. Owns the scaffold:
 * abort diagnostics, keepalive lifecycle, progress-patch semantics, header
 * set, and guaranteed cleanup (keepalive cleared and controller closed in a
 * `finally`, so a rejecting handler can never leak the interval).
 *
 * @param route   Route label for the disconnect diagnostic log.
 * @param request Incoming request (for the abort listener).
 * @param handler The route body. Runs with the stream; its own error
 *                handling/cost accounting stays inside it.
 * @param onSettled Optional post-handler hook that runs in the `finally`
 *                (even when the client disconnected or the handler threw),
 *                before the controller closes — e.g. server-side history
 *                persistence from `emittedLines`. Failures are logged, never
 *                thrown.
 */
export function patchStreamResponse(
  route: string,
  request: Request,
  handler: (stream: PatchStream) => Promise<void>,
  onSettled?: (stream: PatchStream) => Promise<void>
): Response {
  // Diagnostic: log exactly when the client connection drops, so a long
  // query that ends in a "network error" tells us WHICH wall was hit (e.g. a
  // ~300s cap = a hard HTTP timeout still in force, vs later = a different one).
  const reqStart = Date.now();
  try {
    request.signal.addEventListener("abort", () => {
      logger.warn("Client disconnected mid-request", {
        elapsedMs: Date.now() - reqStart,
        route,
      });
    });
  } catch {
    // signal may be unavailable in some runtimes — non-fatal.
  }

  const encoder = new TextEncoder();
  const readable = new ReadableStream({
    async start(controller) {
      let closed = false;
      const emittedLines: string[] = [];

      const emit = (data: string) => {
        emittedLines.push(data);
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          closed = true;
        }
      };

      let stateInitialized = false;
      const emitProgress = (stage: string, step: number, total: number) => {
        const patch = stateInitialized
          ? { op: "replace", path: "/state/__progress", value: { stage, step, total } }
          : { op: "add", path: "/state", value: { __progress: { stage, step, total } } };
        stateInitialized = true;
        emit(JSON.stringify(patch) + "\n");
      };

      const stream: PatchStream = {
        emit,
        emitProgress,
        isClosed: () => closed,
        emittedLines,
      };

      const keepalive = setInterval(() => emit(": keepalive\n"), KEEPALIVE_INTERVAL_MS);

      try {
        await handler(stream);
      } finally {
        clearInterval(keepalive);
        if (onSettled) {
          try {
            await onSettled(stream);
          } catch (err) {
            logger.warn("Patch-stream onSettled hook failed", {
              route,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
        if (!closed) {
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      }
    },
    cancel() {
      // Client aborted — best-effort: subsequent emits become no-ops.
      // In-flight LLM calls and sandbox executions will continue but
      // their outputs are discarded.
    },
  });

  return new Response(readable, { status: 200, headers: PATCH_STREAM_HEADERS });
}
