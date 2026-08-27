/**
 * The sidecar-side WASM executor built on the handoff registry (spec §4a / D6).
 * `createStreamWasmExecutor` returns a `WasmExecutor` that delegates a run to the
 * webview worker over the NDJSON stream: it emits a "wasm-execute" request (id +
 * code + files), awaits the registry promise (resolved when the browser POSTs the
 * result to /api/wasm-result), validates the returned envelope through the RELAY
 * (the browser is untrusted), and decodes it via parseSandboxOutput — the exact
 * ExecutionResult contract every runtime returns.
 *
 * Integration glue (imports parse-output) → coverage-excluded, covered by its own
 * integration test.
 */
import { parseSandboxOutput } from "../parse-output";
import { errMessage } from "@/lib/logger";
import { validateWorkerResult } from "./relay";
import type { HandoffRegistry } from "./handoff-registry";
import type { ExecutionResult, AdditionalFile } from "@/lib/contracts/execution";

/** The message the sidecar emits into the stream for the browser to execute. */
export interface WasmExecuteRequest {
  type: "wasm-execute";
  id: string;
  csvContent: string;
  code: string;
  files: AdditionalFile[];
}

export interface StreamWasmExecutorOpts {
  registry: HandoffRegistry;
  /** Push the execute-request to the browser (the harness turns it into a stream patch). */
  emit: (req: WasmExecuteRequest) => void;
  /** Wall-clock cap; on expiry the pending handoff is rejected. */
  timeoutMs?: number;
}

type WasmExecutorFn = (
  csvContent: string,
  code: string,
  opts: { additionalFiles?: AdditionalFile[]; geojsonContent?: string | null }
) => Promise<ExecutionResult>;

export function createStreamWasmExecutor(o: StreamWasmExecutorOpts): WasmExecutorFn {
  const timeoutMs = o.timeoutMs ?? 120_000;

  return async (csvContent, code, execOpts) => {
    const start = Date.now();
    const { id, promise } = o.registry.create();
    o.emit({ type: "wasm-execute", id, csvContent, code, files: execOpts.additionalFiles ?? [] });

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const envelope = await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            o.registry.reject(id, "timed out"); // release the pending entry
            reject(new Error("timed out"));
          }, timeoutMs);
        }),
      ]);

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
      });
    } catch (err) {
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
    }
  };
}
