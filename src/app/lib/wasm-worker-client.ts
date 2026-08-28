"use client";

import type { WasmExecuteRequest } from "@/lib/contracts/stream-state";
import type { HandoffEnvelope } from "@/lib/sandbox/wasm/handoff-registry";

/**
 * The impure browser edges of the live WASM handoff (spec §4a / build log D6,
 * D8=self): booting the CSP-locked execution worker and POSTing its result envelope
 * back to the sidecar. Lives in app/lib — the sanctioned network-call site — so the
 * React hook (src/hooks/use-wasm-handoff) stays pure wiring around the tested
 * controller. Under the Tauri-desktop `'self'` CSP the worker loads Pyodide + its
 * packages from the bundled same-origin dist (no blob dance, no network egress —
 * see runtime-constants WASM_EXEC_CSP).
 */

/** Where the bundled Pyodide runtime is served (desktop bundle / dev static). */
export const PYODIDE_INDEX_URL = "/pyodide/";

/** Boot the CSP-locked worker, run the request, and return its raw envelope. */
export async function runInWorker(req: WasmExecuteRequest): Promise<HandoffEnvelope> {
  const worker = new Worker("/api/wasm-worker");
  try {
    return await new Promise<HandoffEnvelope>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent) => {
        const d = (e.data ?? {}) as Partial<HandoffEnvelope>;
        resolve({ exitCode: Number(d.exitCode), output: d.output, stderr: d.stderr });
      };
      worker.onerror = (e: ErrorEvent) => reject(new Error(e.message || "worker error"));
      worker.postMessage({ indexURL: PYODIDE_INDEX_URL, request: req });
    });
  } finally {
    worker.terminate();
  }
}

/** POST the worker envelope to /api/wasm-result?id=…, resolving the sidecar handoff. */
export async function postWasmResult(id: string, envelope: HandoffEnvelope): Promise<void> {
  const res = await fetch(`/api/wasm-result?id=${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  if (!res.ok) throw new Error(`wasm-result POST failed: ${res.status}`);
}
