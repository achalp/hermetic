/**
 * The browser side of the live sidecar↔webview handoff (spec §4a / build log D6).
 *
 * The Node run emits a `__wasm_exec` request into the open stream; the browser
 * applies it to spec state and calls `handle(req)` here. This controller drives
 * the round-trip: run the request in the worker (`deps.run`) and POST the result
 * envelope back to `/api/wasm-result` (`deps.post`), so the awaiting sidecar
 * handoff resolves. It is IDEMPOTENT per id — the stream re-delivers the same
 * `__wasm_exec` value on every subsequent patch/render, and each request must run
 * exactly once.
 *
 * Pure (no DOM, no fetch — those are the injected `run`/`post` edges), so it lives
 * inside the wasm pure-logic isolation boundary and is held to 100% coverage. The
 * worker boot and the fetch POST are the impure edges, wired in the React hook.
 */
import type { WasmExecuteRequest } from "@/lib/contracts/stream-state";
import type { HandoffEnvelope } from "./handoff-registry";

export interface ClientHandoffDeps {
  /** Boot/reuse the worker and run the request → the raw result envelope. */
  run: (req: WasmExecuteRequest) => Promise<HandoffEnvelope>;
  /** POST the envelope to /api/wasm-result?id=…; rejects on network failure. */
  post: (id: string, envelope: HandoffEnvelope) => Promise<void>;
  /** Best-effort error sink (logging); never throws back into the controller. */
  onError?: (id: string, err: unknown) => void;
}

export interface ClientHandoff {
  /** React to a webview execute-request. A no-op for a malformed request or an
   *  id already handled (dedupes the stream's repeated re-delivery). */
  handle(req: WasmExecuteRequest | undefined | null): void;
  /** Count of ids handled this session (test / leak visibility). */
  size(): number;
}

export function createClientHandoff(deps: ClientHandoffDeps): ClientHandoff {
  const seen = new Set<string>();

  async function drive(req: WasmExecuteRequest): Promise<void> {
    let envelope: HandoffEnvelope;
    try {
      envelope = await deps.run(req);
    } catch (err) {
      deps.onError?.(req.id, err);
      // The worker never produced a result — still answer the sidecar (a
      // non-zero exit → parseSandboxOutput failure) so its handoff resolves
      // instead of hanging until the supervisor timeout.
      envelope = { exitCode: 1, output: "", stderr: String(err) };
    }
    try {
      await deps.post(req.id, envelope);
    } catch (err) {
      // The POST failed (the run may already have timed out or disconnected);
      // nothing more to do but surface it for logging.
      deps.onError?.(req.id, err);
    }
  }

  return {
    handle(req) {
      if (!req || req.type !== "wasm-execute" || !req.id) return;
      if (seen.has(req.id)) return;
      seen.add(req.id);
      void drive(req);
    },
    size: () => seen.size,
  };
}
