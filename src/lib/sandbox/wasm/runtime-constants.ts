/**
 * WASM-runtime execution constants shared by BOTH Pyodide hosts — the Node
 * parity executor (executor.ts) and the production browser worker (served by
 * /api/wasm-worker). Extracted to a leaf module so the two hosts run byte-for-byte
 * the same prelude and workdir: a drift here would make CI parity green while the
 * shipped browser path computes something subtly different (spec §5 value gate).
 *
 * Pure constants (no imports) → lives inside the wasm isolation boundary.
 */

/** The in-FS working directory both hosts stage into (/data/input.csv, output.json…). */
export const WASM_WORK_DIR = "/data";

/**
 * The execution-context CSP (spec §7 #2) delivered on the WORKER SCRIPT response,
 * so it governs the worker that runs untrusted analysis code. `connect-src 'none'`
 * is the load-bearing boundary: even a captured `fetch`/`WebSocket` ref (or
 * Pyodide's `import js` FFI, which reaches the same worker globals) cannot
 * exfiltrate. `script-src` deliberately OMITS 'self' — a same-origin importScripts
 * / import() URL is itself an exfil channel (data in the path; the request leaves
 * even if the script never runs). Pyodide therefore loads from pre-fetched blob:
 * URLs (`script-src blob:`); 'wasm-unsafe-eval' permits WebAssembly.compile only.
 * This is the exact string the escape suite (e2e/wasm-escape-suite) proved airtight
 * — keep them identical.
 */
export const WASM_EXEC_CSP =
  "default-src 'none'; script-src blob: 'wasm-unsafe-eval'; " +
  "connect-src 'none'; img-src 'none'; worker-src 'none'; child-src 'none'";

/**
 * Minimal WASM-safe Python prelude. The Docker prelude's daemon threads / cgroup
 * guards / os.environ proxy don't exist under WASM (spec §5); keep only the
 * stdlib-safe bits the output contract needs: sys.path for hermetic_runtime, and
 * json allow_nan so write_output can emit NaN/Infinity.
 */
export const WASM_PRELUDE = `
import sys, json
sys.path.insert(0, "${WASM_WORK_DIR}")
_orig_dump, _orig_dumps = json.dump, json.dumps
json.dump = lambda obj, fp, **kw: _orig_dump(obj, fp, **{**kw, "allow_nan": True})
json.dumps = lambda obj, **kw: _orig_dumps(obj, **{**kw, "allow_nan": True})
`;
