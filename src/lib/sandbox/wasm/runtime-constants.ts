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
 * The execution-context CSP (spec §7 #2 / build log D8=self) delivered on the
 * WORKER SCRIPT response, so it governs the worker that runs untrusted analysis
 * code. This is the PRODUCTION (Tauri desktop) policy.
 *
 * SECURITY MODEL — platform isolation, not connect-src 'none'. Here `'self'` is the
 * Tauri custom protocol (`tauri://localhost`): a same-origin request NEVER leaves
 * the machine, so `script-src 'self'` and `connect-src 'self'` carry NO internet
 * egress channel — an attacker cannot exfiltrate even via Pyodide's `import js`
 * FFI, because there is no network host reachable but the local app. This is why
 * `'self'` is admissible here even though it is a real exfil channel on the web:
 * the WASM tier ships as the DESKTOP download (build log D3), where 'self' is local.
 * `'self'` is required so Pyodide can load its `.asm` (via `import()`, script-src)
 * and its `.wasm`/stdlib/wheels (via `fetch`, connect-src) from the bundled,
 * same-origin dist — the exact policy the browser-analysis e2e proves boots + runs.
 *
 * RESIDUAL (documented, follow-up hardening): under `connect-src 'self'` the worker
 * can also reach the app's own same-origin `/api/*` routes. No data can LEAVE the
 * machine, but untrusted code could call local endpoints — a future hardening
 * should serve the exec assets from a distinct origin or reject exec-worker-
 * originated `/api` requests. Tracked in build log D10.
 *
 * WEB-DEPLOY TARGET (not this build): the strict `connect-src 'none'; script-src
 * blob:` policy — proven airtight by e2e/wasm-escape-suite — remains the goal for a
 * hypothetical web deployment, gated on the offline blob-asset plumbing (D8 opt 1).
 */
export const WASM_EXEC_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' blob:; " +
  "connect-src 'self'; img-src 'none'; worker-src 'none'; child-src 'none'";

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
