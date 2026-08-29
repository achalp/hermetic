import { NextResponse } from "next/server";
import { WASM_EXEC_CSP } from "@/lib/sandbox/wasm/runtime-constants";
import { WASM_WORKER_SOURCE } from "@/lib/sandbox/wasm/worker-source";

/**
 * Serves the execution Web Worker script for the WASM sandbox (spec §4a / §7 /
 * build log D6, D8=self). The response carries the locked execution CSP
 * (WASM_EXEC_CSP): a worker inherits the CSP delivered on its OWN script response,
 * so this seals the untrusted-execution context. Under the Tauri-desktop model
 * `'self'` is the local app protocol (no internet egress — see runtime-constants),
 * so the worker loads Pyodide + its packages from the bundled same-origin dist and
 * still cannot exfiltrate.
 *
 * The worker source lives in the shared `worker-source` module (the E2.5 e2e boots
 * the SAME string, so the gate can't validate a worker that differs from what ships).
 */
export function GET() {
  return new NextResponse(WASM_WORKER_SOURCE, {
    status: 200,
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "content-security-policy": WASM_EXEC_CSP,
      "cache-control": "no-store",
    },
  });
}
