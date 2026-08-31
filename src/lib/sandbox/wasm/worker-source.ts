import { WASM_PRELUDE, WASM_WORK_DIR } from "./runtime-constants";
import { DUCKDB_BOOT_FN_SOURCE, DUCKDB_PY_SHIM } from "./duckdb-worker";

/**
 * The execution Web Worker source (spec §4a / build log D6, D8=self), shared by the
 * `/api/wasm-worker` route (which serves it under WASM_EXEC_CSP) and the E2.5
 * acceptance e2e (which boots THIS exact string) — so the running-app gate can
 * never validate a worker that differs from production.
 *
 * A classic worker (so `importScripts` works) that embeds the SHARED prelude +
 * workdir, so it can never drift from the Node parity executor. Under the Tauri
 * `'self'` CSP it loads Pyodide + packages from the bundled same-origin dist and
 * performs no cross-origin I/O. It returns a RAW envelope {id, exitCode, output,
 * stderr} — the sidecar relay + parseSandboxOutput decode it.
 *
 * Frozen postMessage contract with app/lib/wasm-worker-client:
 *   ← { indexURL, request: WasmExecuteRequest }
 *   → { id, exitCode, output: <output.json|null>, stderr?: <stderr.txt> }
 */
export const WASM_WORKER_SOURCE = `
"use strict";
${DUCKDB_BOOT_FN_SOURCE}
self.onmessage = async (e) => {
  const { indexURL, request } = e.data || {};
  const id = request && request.id;
  try {
    importScripts(indexURL + "pyodide.js"); // same-origin bundled dist (script-src 'self')
    const pyodide = await self.loadPyodide({ indexURL });
    await pyodide.loadPackage(["numpy", "pandas"]);
    // scipy is IN the Pyodide distribution but not loaded by default (a ~30MB
    // wheel a pandas-only run must not pay for). The docker image ships it, so
    // prompted code legitimately imports it — load it exactly when the CODE does
    // (build log D39; same opt-in shape as codeNeedsDuckDb).
    if (/\b(?:import|from)\s+scipy\b/.test(String(request.code || ""))) {
      await pyodide.loadPackage(["scipy"]);
    }
    // DuckDB is booted only when the request asks (build log D18): the engine is a
    // 41MB wasm module, so a pandas-only run must not pay for it. Parameters arrive
    // as DATA — the CSP allows wasm-unsafe-eval but NOT unsafe-eval.
    if (request.duckdb) {
      await __hermeticBootDuckDb(request.duckdb.base, request.duckdb.aliases || []);
    }

    const WORK_DIR = ${JSON.stringify(WASM_WORK_DIR)};
    // Clean + recreate the workdir, then stage the run's files (the request's files
    // already include the hermetic_runtime package — the sidecar prepends it before
    // dispatch), the input CSV, and optional GeoJSON.
    pyodide.runPython(
      'import shutil, os; shutil.rmtree(' + JSON.stringify(WORK_DIR) +
      ', ignore_errors=True); os.makedirs(' + JSON.stringify(WORK_DIR) + ', exist_ok=True)'
    );
    for (const f of (request.files || [])) {
      const slash = f.path.lastIndexOf("/");
      if (slash > 0) pyodide.FS.mkdirTree(f.path.slice(0, slash));
      pyodide.FS.writeFile(f.path, f.content);
    }
    // Inline CSV + optional GeoJSON FIRST (only when present), so a host-materialized
    // input delivered via fetchInputs below can OVERRIDE /data/input.csv (a remote
    // source arrives as a fetched CSV with an empty inline csvContent).
    if (request.csvContent) pyodide.FS.writeFile(WORK_DIR + "/input.csv", request.csvContent);
    if (request.geojsonContent) pyodide.FS.writeFile(WORK_DIR + "/input.geojson", request.geojsonContent);

    // Host-materialized inputs (D11/D13 / option B): FETCH each same-origin token URL
    // (connect-src 'self') and write the raw bytes to its FS path — LAST, so they win
    // over the inline CSV. The remote fetch already happened host-side through the Rust
    // egress core — the worker only ever touches a local, run-scoped same-origin URL.
    for (const inp of (request.fetchInputs || [])) {
      const resp = await fetch(inp.url);
      if (!resp.ok) throw new Error("input fetch failed (" + resp.status + "): " + inp.path);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      const slash = inp.path.lastIndexOf("/");
      if (slash > 0) pyodide.FS.mkdirTree(inp.path.slice(0, slash));
      pyodide.FS.writeFile(inp.path, bytes);
    }

    // Same prelude + exit semantics as the Node executor: a Python exception →
    // exitCode 1 + stderr.txt, so the sidecar's parseSandboxOutput error path
    // lights up identically to Docker.
    let exitCode = 0;
    try {
      const duckShim = request.duckdb ? ${JSON.stringify(DUCKDB_PY_SHIM)} + "\\n" : "";
      await pyodide.runPythonAsync(
        ${JSON.stringify(WASM_PRELUDE)} + "\\n" + duckShim + request.code
      );
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
