"use client";

import type { WasmExecuteRequest } from "@/lib/contracts/stream-state";
import type { HandoffEnvelope } from "@/lib/sandbox/wasm/handoff-registry";

/**
 * The impure browser edges of the live WASM handoff (spec §4a / build log D6):
 * booting the CSP-locked execution worker and POSTing its result envelope back to
 * the sidecar. Lives in app/lib — the sanctioned network-call site — so the React
 * hook (src/hooks/use-wasm-handoff) stays pure wiring around the tested controller.
 *
 * ── E2.5 GATE ───────────────────────────────────────────────────────────────────
 * The worker runs under `connect-src 'none'`, so it cannot fetch its own package /
 * wasm bytes; a fully-offline asset-delivery path (main-thread pre-fetch → FS
 * inject, or a Tauri custom-protocol host) is required and is validated by the
 * running-app acceptance test against the bundled assets. Until that is green the
 * live path is NOT claimed to work end to end.
 */

/** Where the bundled Pyodide runtime is served (desktop bundle / dev static). */
export const PYODIDE_INDEX_URL = "/pyodide/";

/** Boot the CSP-locked worker, run the request, and return its raw envelope. */
export async function runInWorker(req: WasmExecuteRequest): Promise<HandoffEnvelope> {
  // Fetch pyodide.js on the MAIN thread (normal CSP) and hand it to the worker as
  // a blob — the worker's `connect-src 'none'` forbids it fetching scripts itself.
  const res = await fetch(PYODIDE_INDEX_URL + "pyodide.js");
  if (!res.ok) throw new Error(`pyodide.js fetch failed: ${res.status}`);
  const blobUrl = URL.createObjectURL(await res.blob());
  const worker = new Worker("/api/wasm-worker");
  try {
    return await new Promise<HandoffEnvelope>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent) => {
        const d = (e.data ?? {}) as Partial<HandoffEnvelope>;
        resolve({ exitCode: Number(d.exitCode), output: d.output, stderr: d.stderr });
      };
      worker.onerror = (e: ErrorEvent) => reject(new Error(e.message || "worker error"));
      worker.postMessage({ pyodideScriptUrl: blobUrl, indexURL: PYODIDE_INDEX_URL, request: req });
    });
  } finally {
    worker.terminate();
    URL.revokeObjectURL(blobUrl);
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
