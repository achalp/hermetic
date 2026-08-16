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
import { logger, errMessage } from "@/lib/logger";
import { runWithRunId, getRunId } from "@/lib/run-context";
import { parsePatchLines, readRunError } from "@/lib/pipeline/patch-lines";
import { diagEvent } from "@/lib/diagnostics/run-diagnostics";
import { registerRun, endRun, type SandboxProgress } from "@/lib/pipeline/run-control";
import {
  openRunChannel,
  publishRunLine,
  closeRunChannel,
  setRunChannelMeta,
} from "@/lib/pipeline/run-stream-hub";
import { acquireWakeLock } from "@/lib/wake-lock";

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
   * Associate the run with its source + question once the handler resolves
   * them, so a reconnecting client can discover it (see run-stream-hub). Safe
   * to call more than once (e.g. warehouse csvId is known only mid-run).
   */
  setMeta(meta: { csvId?: string; question?: string }): void;
  /**
   * Every emitted line, including after the client disconnected. Lets the
   * route assemble the final spec server-side and persist history for a
   * client that dropped mid-analysis — the run already happened; this stops
   * it being wasted. Backed by the run's hub channel buffer (single source of
   * truth, also replayed to reconnecting clients).
   */
  emittedLines: string[];
}

/** Where emitted lines go — a Response controller, stdout, a file. */
export interface PatchSink {
  /** Write one raw line. Throwing marks the sink closed (client gone). */
  write(data: string): void;
}

/**
 * Transport-agnostic patch-stream core (modularization M6-6a/WS5): run
 * correlation, run registry + hub channel, emit/progress semantics,
 * keepalive + wake-lock lifecycle, guaranteed cleanup. patchStreamResponse
 * wraps it in a Response for the Next routes; the CLI harness drives it
 * with a stdout sink.
 *
 * Returns the runId, so a non-HTTP caller (the MCP analyze tool) can join
 * its own records to this run's logs/diagnostics/cost rows — the id was
 * otherwise only reachable by fishing the `__runId` patch out of the lines.
 */
export async function runPatchStream(
  route: string,
  sink: PatchSink,
  handler: (stream: PatchStream) => Promise<void>,
  onSettled?: (stream: PatchStream) => Promise<void>
): Promise<string> {
  // Run correlation: every logger line, diagnostics record, and cost row
  // inside the handler carries this run's id (see lib/run-context.ts). The
  // emit/stream machinery lives INSIDE this scope because it binds to the
  // run's hub channel — whose id is the runId assigned here.
  return await runWithRunId(async () => {
    const runId = getRunId()!;
    // Register the run so the stop endpoint can abort it and the sandbox
    // runner can subscribe to its signal + stream execution progress.
    registerRun(runId, emitExecProgress);
    // Open the run's output channel; its buffer IS emittedLines (single
    // source of truth — replayed to a reconnecting client, and read by the
    // disconnect history-save). See run-stream-hub.
    const emittedLines = openRunChannel(runId, { route });

    let closed = false;
    const emit = (data: string) => {
      // Buffer + multicast to reconnect subscribers, THEN feed this
      // request's own stream. A dropped original connection (closed) never
      // stops the buffering, so a reattaching client still gets everything.
      publishRunLine(runId, data);
      if (closed) return;
      try {
        sink.write(data);
      } catch {
        closed = true;
      }
    };

    let stateInitialized = false;
    const emitProgress = (stage: string, step: number, total: number) => {
      // Also record the transition in the run's diagnostics JSONL — the
      // stream patches vanish with the client, so after a disconnect or
      // crash the server otherwise had no record of which stage a run
      // reached (the disconnect log gives elapsedMs but not stage).
      diagEvent("stage", { stage, step, total });
      const patch = stateInitialized
        ? { op: "replace", path: "/state/__progress", value: { stage, step, total } }
        : // The FIRST state patch also carries __runId so the client knows
          // which run to POST to /api/query/stop (the cancel button).
          {
            op: "add",
            path: "/state",
            value: { __progress: { stage, step, total }, __runId: runId },
          };
      stateInitialized = true;
      emit(JSON.stringify(patch) + "\n");
    };

    // Detailed execution progress from the sandbox (phase/fraction/rows/
    // elapsed) — distinct from the coarse stage above. Fired via the
    // run-control registry so the sandbox runner needs no param threading.
    function emitExecProgress(p: SandboxProgress) {
      // The one-time up-front estimate lives under __estimate so it persists
      // as a banner; live heartbeats update __exec. Both under /state, which
      // the first emitProgress creates before execution — guard anyway.
      const key = p.phase === "estimate" ? "__estimate" : "__exec";
      if (!stateInitialized) {
        stateInitialized = true;
        emit(JSON.stringify({ op: "add", path: "/state", value: { [key]: p } }) + "\n");
      } else {
        emit(JSON.stringify({ op: "add", path: `/state/${key}`, value: p }) + "\n");
      }
    }

    const stream: PatchStream = {
      emit,
      emitProgress,
      isClosed: () => closed,
      setMeta: (meta) => setRunChannelMeta(runId, meta),
      emittedLines,
    };

    const keepalive = setInterval(() => emit(": keepalive\n"), KEEPALIVE_INTERVAL_MS);
    // Keep the machine awake for the WHOLE run, not just sandbox execution:
    // an idle-sleep during the long LLM code-gen phase drops the client's
    // stream (observed as "TypeError: network error"). Ref-counted, so the
    // sandbox/warehouse holds nest under this one caffeinate process.
    const releaseWakeLock = acquireWakeLock(`run:${runId}`);

    logger.info("Run started", { route });
    const started = Date.now();
    let handlerFailed = false;
    try {
      await handler(stream);
    } catch (err) {
      handlerFailed = true;
      throw err;
    } finally {
      releaseWakeLock();
      endRun(runId);
      clearInterval(keepalive);
      // Signal reconnect subscribers that the run ended (they close their
      // streams), and retain the buffer briefly for a late reconnect.
      closeRunChannel(runId);
      // One terminal line per run (runId implicit via run context). The cost
      // epilogue's "Cost by phase" only fires when an accumulator has LLM
      // calls — a zero-LLM failure or disconnect previously ended with no
      // record of how the run finished. Pipelines catch their own errors and
      // emit `/state/__error`, so the outcome reads the stream too.
      const outcome = handlerFailed
        ? "error"
        : readRunError(parsePatchLines(emittedLines))
          ? "error"
          : closed
            ? "disconnected"
            : "ok";
      logger.info("Run finished", { route, outcome, durationMs: Date.now() - started });
      if (onSettled) {
        try {
          await onSettled(stream);
        } catch (err) {
          logger.warn("Patch-stream onSettled hook failed", {
            route,
            error: errMessage(err),
          });
        }
      }
    }
    return runId;
  });
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
      let controllerClosed = false;
      const sink: PatchSink = {
        write(data) {
          controller.enqueue(encoder.encode(data)); // throws once client is gone
        },
      };
      try {
        await runPatchStream(route, sink, handler, onSettled);
      } finally {
        if (!controllerClosed) {
          try {
            controller.close();
            controllerClosed = true;
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
