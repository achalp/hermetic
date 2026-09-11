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

/** Boot the CSP-locked worker, run the request, and return its raw envelope.
 *  `signal` aborts the run: the worker is terminated (the wasm counterpart of
 *  `docker rm -f` — a resolved sidecar alone would leave Python burning CPU
 *  here) and the promise rejects. Live progress frames (kind:"progress") are
 *  forwarded to /api/wasm-result best-effort and never resolve the run. */
export async function runInWorker(
  req: WasmExecuteRequest,
  signal?: AbortSignal
): Promise<HandoffEnvelope> {
  const worker = new Worker("/api/wasm-worker");
  const onAbort = () => worker.terminate();
  try {
    return await new Promise<HandoffEnvelope>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("cancelled"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => {
          onAbort();
          reject(new Error("cancelled"));
        },
        { once: true }
      );
      worker.onmessage = (e: MessageEvent) => {
        const d = (e.data ?? {}) as Partial<HandoffEnvelope> & { kind?: string };
        if (d.kind === "progress") {
          void postWasmProgress(req.id, d as Record<string, unknown>);
          return;
        }
        resolve({ exitCode: Number(d.exitCode), output: d.output, stderr: d.stderr });
      };
      worker.onerror = (e: ErrorEvent) => reject(new Error(e.message || "worker error"));
      worker.postMessage({ indexURL: PYODIDE_INDEX_URL, request: req });
    });
  } finally {
    worker.terminate();
  }
}

/** Forward a worker progress frame to the sidecar. Best-effort: a failed or
 *  rejected forward must never disturb the run (the sidecar treats progress as
 *  advisory and the relay re-validates the frame server-side anyway). */
async function postWasmProgress(id: string, frame: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`/api/wasm-result?id=${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "progress",
        phase: frame.phase,
        detail: frame.detail,
        fraction: frame.fraction,
      }),
    });
  } catch {
    // Advisory channel — drop silently.
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
