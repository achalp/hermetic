"use client";

import { useEffect, useRef } from "react";
import type { Spec } from "@/lib/contracts/spec";
import { readStreamState } from "@/lib/contracts/stream-state";
import { createClientHandoff, type ClientHandoffDeps } from "@/lib/sandbox/wasm/client-handoff";
import { runInWorker, postWasmResult } from "@/app/lib/wasm-worker-client";
import { logClient } from "@/app/lib/client-log";

/**
 * The browser half of the live sidecar↔webview handoff (spec §4a / build log D6).
 *
 * When the run (under the WASM runtime) needs to execute code it emits a
 * `__wasm_exec` request into the stream; this hook watches the streaming spec for
 * that request, runs it in the CSP-locked worker, and POSTs the result envelope to
 * /api/wasm-result — which resolves the sidecar's pending handoff so the run
 * resumes. The round-trip logic + dedupe live in the pure `createClientHandoff`
 * controller; the impure edges (worker boot, fetch POST) live in
 * app/lib/wasm-worker-client. The offline Pyodide asset boot under the strict CSP
 * is the E2.5 running-app gate (see that module) — not claimed working until green.
 */
export function useWasmHandoff(spec: Spec | null, deps?: Partial<ClientHandoffDeps>): void {
  const ctrlRef = useRef<ReturnType<typeof createClientHandoff> | null>(null);
  if (!ctrlRef.current) {
    ctrlRef.current = createClientHandoff({
      run: deps?.run ?? runInWorker,
      post: deps?.post ?? postWasmResult,
      onError:
        deps?.onError ??
        ((id, err) => logClient("error", "WASM handoff failed", { id, err: String(err) })),
    });
  }
  useEffect(() => {
    const req = readStreamState(spec).__wasm_exec;
    if (req) ctrlRef.current!.handle(req);
  }, [spec]);
}
