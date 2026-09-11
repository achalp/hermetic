/**
 * The sidecar-side WASM executor built on the handoff registry (spec §4a / D6).
 * `createStreamWasmExecutor` returns a `WasmExecutor` that delegates a run to the
 * webview worker over the NDJSON stream: it emits a "wasm-execute" request (id +
 * code + files), awaits the registry promise (resolved when the browser POSTs the
 * result to /api/wasm-result), validates the returned envelope through the RELAY
 * (the browser is untrusted), and decodes it via parseSandboxOutput — the exact
 * ExecutionResult contract every runtime returns.
 *
 * Lifetime policy (execution-control parity with Docker): when the caller passes
 * a run AbortSignal, THAT is the only lifetime control — no wall clock, matching
 * "no analysis timeout ever; stop-on-demand" (a fixed 120s cap killed a
 * legitimate planet-scale geo scan: run 9cb7770b attempt 3). On abort the
 * pending handoff rejects AND a cancel request is emitted so the browser
 * terminates the worker (killing the sidecar side alone would leave Python
 * burning CPU in the webview). The wall clock survives ONLY as a fallback for
 * signal-less callers (headless/tests), where nothing else could ever end a
 * hung handoff.
 *
 * Integration glue (imports parse-output) → coverage-excluded, covered by its own
 * integration test.
 */
import { parseSandboxOutput } from "../parse-output";
import { errMessage } from "@/lib/logger";
import { validateWorkerResult } from "./relay";
import type { HandoffRegistry, HandoffProgress } from "./handoff-registry";
import type {
  ExecutionResult,
  AdditionalFile,
  SandboxProgress,
  SkillFailureHint,
} from "@/lib/contracts/execution";
import type { WasmExecuteRequest } from "@/lib/contracts/stream-state";

// The execute-request shape is defined in the shared stream-state contract (the
// browser consumer imports it without any server code). Re-exported here so the
// sidecar-side importers (run-control, patch-stream) keep their existing import.
export type { WasmExecuteRequest };

export interface StreamWasmExecutorOpts {
  registry: HandoffRegistry;
  /** Push the execute-request to the browser (the harness turns it into a stream patch). */
  emit: (req: WasmExecuteRequest) => void;
  /** Push a cancel for an in-flight request (browser terminates that worker). */
  emitCancel?: (id: string) => void;
  /** Fallback wall-clock cap, used ONLY when the run supplies no AbortSignal. */
  timeoutMs?: number;
}

type WasmExecutorFn = (
  csvContent: string,
  code: string,
  opts: {
    additionalFiles?: AdditionalFile[];
    geojsonContent?: string | null;
    fetchInputs?: { path: string; url: string }[];
    duckdb?: { base: string; aliases: { name: string; url: string }[]; spatial?: boolean };
    /** Run abort signal — when present, replaces the wall clock entirely. */
    signal?: AbortSignal;
    /** Live progress consumer (relay-validated frames from the worker). */
    onProgress?: (p: SandboxProgress) => void;
    /** Phase-keyed failure remedies from the run's active skills. */
    failureHints?: () => SkillFailureHint[];
  }
) => Promise<ExecutionResult>;

export function createStreamWasmExecutor(o: StreamWasmExecutorOpts): WasmExecutorFn {
  const fallbackTimeoutMs = o.timeoutMs ?? 120_000;

  return async (csvContent, code, execOpts) => {
    const start = Date.now();
    const signal = execOpts.signal;
    const { id, promise } = o.registry.create({
      ...(execOpts.onProgress
        ? {
            onProgress: (p: HandoffProgress) =>
              execOpts.onProgress!({
                phase: p.phase,
                ...(p.detail !== undefined ? { detail: p.detail } : {}),
                ...(p.fraction !== undefined ? { fraction: p.fraction } : {}),
              }),
          }
        : {}),
    });
    // The normal path awaits `promise` through the race below, but the cleanup
    // reject() in catch (e.g. when emit throws before the race starts) would
    // otherwise reject an un-awaited promise → an unhandled rejection. A benign
    // catch marks it consumed; the race still sees a real rejection normally.
    void promise.catch(() => {});

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let stopped = false;
    const onAbort = () => {
      stopped = true;
      o.registry.reject(id, "stopped");
      // Tell the browser to terminate the worker — resolving our side alone
      // would leave the analysis burning CPU in the webview.
      try {
        o.emitCancel?.(id);
      } catch {
        // The stream may already be gone (the usual reason for the abort).
      }
    };
    try {
      if (signal?.aborted) {
        onAbort();
        throw new Error("stopped before dispatch");
      }
      signal?.addEventListener("abort", onAbort, { once: true });

      // Emit INSIDE the try: if the run has no live stream to dispatch into,
      // `emit` throws — the catch below rejects the pending handoff (no leak)
      // and returns a clean failure instead of an unhandled rejection.
      o.emit({
        type: "wasm-execute",
        id,
        csvContent,
        code,
        files: execOpts.additionalFiles ?? [],
        geojsonContent: execOpts.geojsonContent ?? null,
        ...(execOpts.fetchInputs?.length ? { fetchInputs: execOpts.fetchInputs } : {}),
        ...(execOpts.duckdb ? { duckdb: execOpts.duckdb } : {}),
      });

      const races: Promise<never>[] = [];
      if (!signal) {
        races.push(
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              timedOut = true;
              o.registry.reject(id, "timed out"); // release the pending entry
              // Terminate the browser worker too — a timed-out handoff must
              // not leave the analysis burning CPU (same as the abort path).
              try {
                o.emitCancel?.(id);
              } catch {
                // The stream may already be gone.
              }
              reject(new Error("timed out"));
            }, fallbackTimeoutMs);
          })
        );
      }
      const envelope = await Promise.race([promise, ...races]);

      // The envelope crossed from the UNTRUSTED webview → validate via the relay
      // (bounded shape/size/depth) before trusting it as an output.json.
      const verdict = validateWorkerResult({
        kind: "result",
        exitCode: envelope.exitCode,
        output: envelope.output,
        ...(envelope.stderr !== undefined ? { stderr: envelope.stderr } : {}),
      });
      if (!verdict.ok) {
        return {
          success: false,
          error: `The in-browser run returned an invalid result envelope: ${verdict.reason}.`,
          errorKind: "infra",
          execution_ms: Date.now() - start,
        };
      }

      const out = verdict.message.output;
      const readFile = async (path: string): Promise<string | null> => {
        if (path.endsWith("output.json"))
          return typeof out === "string" ? out : JSON.stringify(out);
        if (path.endsWith("stderr.txt")) return verdict.message.stderr ?? null;
        return null;
      };
      return parseSandboxOutput({
        readFile,
        workDir: "/data",
        runtime: "wasm",
        exitCode: verdict.message.exitCode,
        executionMs: Date.now() - start,
        skillFailureHints: execOpts.failureHints?.() ?? [],
      });
    } catch (err) {
      // Release the pending entry (no-op if already settled by resolve/timeout)
      // so a failed dispatch never leaks a handoff into the registry.
      o.registry.reject(id, "handoff aborted");
      if (stopped) {
        return {
          success: false,
          error: "The analysis was stopped.",
          errorKind: "stopped",
          execution_ms: Date.now() - start,
        };
      }
      return {
        success: false,
        error: timedOut
          ? "The in-browser analysis timed out."
          : `The in-browser analysis failed: ${errMessage(err)}.`,
        errorKind: timedOut ? "timeout" : "infra",
        execution_ms: Date.now() - start,
      };
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}
