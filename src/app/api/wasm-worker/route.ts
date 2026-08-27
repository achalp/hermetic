import { NextResponse } from "next/server";
import { WASM_EXEC_CSP, WASM_PRELUDE, WASM_WORK_DIR } from "@/lib/sandbox/wasm/runtime-constants";

/**
 * Serves the execution Web Worker script for the WASM sandbox (spec §4a / §7 /
 * build log D6). The response carries the locked execution CSP (WASM_EXEC_CSP):
 * because a worker inherits the CSP delivered on its OWN script response, this is
 * how the untrusted-execution context is sealed — `connect-src 'none'` blocks
 * every egress vector (proven by e2e/wasm-escape-suite), and `script-src blob:`
 * (no 'self') runs Pyodide from pre-fetched blob URLs while blocking same-origin
 * script-URL exfil.
 *
 * The worker is intentionally a plain string (not a bundled module): it must be a
 * classic worker so `importScripts(blobUrl)` works under the CSP, and it embeds
 * the SHARED prelude/workdir constants so it can never drift from the Node parity
 * executor. The main thread (use-wasm-handoff) delivers Pyodide + package bytes as
 * blobs/FS files — the worker performs NO network I/O itself.
 */

// Frozen contract with the main-thread runner (use-wasm-handoff.ts):
//   ← postMessage { pyodideScriptUrl: blob:, indexURL, request: WasmExecuteRequest }
//   → postMessage { id, exitCode, output: <output.json|null>, stderr?: <stderr.txt> }
// The worker does not decode the envelope — the sidecar relay + parseSandboxOutput
// own that. It returns raw {exitCode, output, stderr}, matching HandoffEnvelope.
const WORKER_JS = `
"use strict";
self.onmessage = async (e) => {
  const { pyodideScriptUrl, indexURL, request } = e.data || {};
  const id = request && request.id;
  try {
    importScripts(pyodideScriptUrl); // pyodide.js delivered as a blob (script-src blob:)
    const pyodide = await self.loadPyodide({ indexURL });
    await pyodide.loadPackage(["numpy", "pandas"]);

    const WORK_DIR = ${JSON.stringify(WASM_WORK_DIR)};
    // Clean + recreate the workdir, then stage the run's files (the request's
    // files already include the hermetic_runtime package — the sidecar prepends
    // it before dispatch), the input CSV, and optional GeoJSON.
    pyodide.runPython(
      'import shutil, os; shutil.rmtree(' + JSON.stringify(WORK_DIR) +
      ', ignore_errors=True); os.makedirs(' + JSON.stringify(WORK_DIR) + ', exist_ok=True)'
    );
    for (const f of (request.files || [])) {
      const slash = f.path.lastIndexOf("/");
      if (slash > 0) pyodide.FS.mkdirTree(f.path.slice(0, slash));
      pyodide.FS.writeFile(f.path, f.content);
    }
    pyodide.FS.writeFile(WORK_DIR + "/input.csv", request.csvContent || "");
    if (request.geojsonContent) pyodide.FS.writeFile(WORK_DIR + "/input.geojson", request.geojsonContent);

    // Same prelude + exit semantics as the Node executor: a Python exception →
    // exitCode 1 + stderr.txt, so the sidecar's parseSandboxOutput error path
    // lights up identically to Docker.
    let exitCode = 0;
    try {
      await pyodide.runPythonAsync(${JSON.stringify(WASM_PRELUDE)} + "\\n" + request.code);
    } catch (err) {
      exitCode = 1;
      pyodide.FS.writeFile(WORK_DIR + "/stderr.txt", String((err && err.message) || err));
    }
    const read = (p) => { try { return pyodide.FS.readFile(p, { encoding: "utf8" }); } catch { return null; } };
    self.postMessage({
      id,
      exitCode,
      output: read(WORK_DIR + "/output.json"),
      stderr: read(WORK_DIR + "/stderr.txt") || undefined,
    });
  } catch (err) {
    // Boot/stage failure — report a non-zero envelope so the sidecar resolves.
    self.postMessage({ id, exitCode: 1, output: null, stderr: String((err && err.message) || err) });
  }
};
`;

export function GET() {
  return new NextResponse(WORKER_JS, {
    status: 200,
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "content-security-policy": WASM_EXEC_CSP,
      "cache-control": "no-store",
    },
  });
}
