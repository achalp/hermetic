/**
 * The WASM-safe prelude + capability pre-check (spec pyodide-wasm-sandbox §5/§6).
 *
 * Pure string/logic — no side effects, no imports outside this seam. Two jobs:
 *
 *  1. buildWasmPrelude() — the minimal Python the WASM executor prepends to
 *     generated code. It is the Docker prelude (docker/sandbox/prelude.py)
 *     stripped to ONLY what runs under Pyodide + DuckDB-WASM (see the comment in
 *     the returned source for the drop list and its rationale).
 *  2. detectUnsupportedFeatures() — a regex pre-check that flags generated code
 *     using features the WASM tier can't serve (statsmodels/lifelines/networkx
 *     imports; in-worker remote reads), so the router sends it to Docker (or the
 *     codegen variant prunes it). A UX router, NOT a security control — the §7
 *     CSP + httpfs-off is the real boundary; this only routes.
 *
 * Kept dependency-free so it is trivially 100%-covered and reusable by the
 * Node-worker (Phase 1a) and browser relay (Phase 1c) alike.
 */

/**
 * The Python prelude prepended to generated code before it runs under Pyodide.
 *
 * DROPPED from the Docker prelude (spec §5), and why each is WASM-incompatible:
 *   - the daemon heartbeat + memory-watchdog THREADS: Pyodide is single-threaded
 *     (no OS threads without COOP/COEP + a worker), so a background poll loop can
 *     never run; progress/liveness is the supervisor's job (§7 T3).
 *   - cgroup / /proc reads (`_mem_limit_bytes`, `_mem_usage_bytes`): no cgroup
 *     and no procfs inside the WASM VM — every read would just fail.
 *   - `os._exit(137)` OOM abort: the wall-clock + heap cap live on the main
 *     SUPERVISOR context (§7 T3), which `worker.terminate()`s — Python can't and
 *     must not self-kill the tab.
 *   - `os.environ` HTTP-proxy plumbing (`HERMETIC_HTTP_PROXY`, DuckDB `SET
 *     http_proxy`): the worker is `connect-src 'none'` with httpfs OFF (§6a) —
 *     there is no in-worker egress door to configure; remote reads go through the
 *     trusted core, never DuckDB's proxy.
 *   - DuckDB thread / temp_directory / memory_limit / spill PRAGMAs: DuckDB-WASM
 *     is single-threaded with no disk-spill (§5) — those PRAGMAs are unsupported
 *     and the size cap replaces them as the OOM valve.
 *
 * KEPT (the only two WASM-safe bits):
 *   - `sys.path.insert(0, "/data")` so `import hermetic_runtime` resolves the
 *     vendored package staged into MEMFS.
 *   - the `json.dump`/`json.dumps` `allow_nan=True` patch so `write_output` can
 *     emit NaN/Inf (the host parser tolerates non-finite JSON on the way back).
 */
export function buildWasmPrelude(): string {
  return `# ── WASM-safe prelude (spec pyodide-wasm-sandbox §5) ─────────────────────────
# The Docker prelude stripped to what runs under Pyodide + DuckDB-WASM. DROPPED:
# the heartbeat/memory-watchdog THREADS (Pyodide is single-threaded), the cgroup
# //proc memory reads and os._exit OOM abort (no cgroup/procfs; the SUPERVISOR
# enforces the cap), the os.environ HTTP-proxy plumbing (worker is
# connect-src 'none', httpfs OFF — no in-worker egress door), and the DuckDB
# thread/temp_directory/memory_limit PRAGMAs (DuckDB-WASM is single-threaded, no
# disk-spill). KEPT: /data on sys.path for hermetic_runtime, and the json
# allow_nan patch so write_output can emit NaN/Inf.
import sys as _sys
if "/data" not in _sys.path:
    _sys.path.insert(0, "/data")

import json as _json_mod
_orig_dump = _json_mod.dump
_orig_dumps = _json_mod.dumps
def _safe_dump(*a, **kw):
    kw['allow_nan'] = True
    return _orig_dump(*a, **kw)
def _safe_dumps(*a, **kw):
    kw['allow_nan'] = True
    return _orig_dumps(*a, **kw)
_json_mod.dump = _safe_dump
_json_mod.dumps = _safe_dumps
`;
}

/** The result of the WASM-tier capability pre-check. */
export interface UnsupportedFeatures {
  /** Canonical names of imported packages the WASM tier can't provide. */
  imports: string[];
  /** Human-readable reasons (one per detected feature) for the router/UX. */
  reasons: string[];
}

/**
 * Packages named to the model (prompts.ts:316/319/325) but ABSENT from the image
 * — already latent ImportErrors even in Docker, and no Pyodide wheel in the WASM
 * tier. Their presence routes the run to Docker (or the codegen variant prunes
 * the chart family). Matched as a real import statement, not a bare mention.
 */
const UNSUPPORTED_IMPORTS: ReadonlyArray<{ readonly name: string; readonly reason: string }> = [
  {
    name: "statsmodels",
    reason:
      "imports statsmodels — no Pyodide wheel in the WASM tier (a latent ImportError even in Docker); route to Docker or prune the chart family",
  },
  {
    name: "lifelines",
    reason:
      "imports lifelines — no Pyodide wheel in the WASM tier (a latent ImportError even in Docker); route to Docker or prune the survival/KM family",
  },
  {
    name: "networkx",
    reason:
      "imports networkx — no Pyodide wheel in the WASM tier (a latent ImportError even in Docker); route to Docker or prune the network-graph family",
  },
];

/**
 * In-worker remote reads. The worker runs `connect-src 'none'` with DuckDB-WASM
 * httpfs OFF (§6a/§7), so these fail STRUCTURALLY at runtime — the pre-check
 * routes them to Docker (or the codegen variant rewrites the read as a
 * core-fetched local MEMFS file) instead of letting the run dead-end. Detection
 * mirrors docker-utils `codeDoesRemoteIo` so the two tiers agree on "remote".
 */
const REMOTE_READS: ReadonlyArray<{ readonly pattern: RegExp; readonly reason: string }> = [
  {
    pattern: /read_parquet\(\s*['"]https?:\/\//i,
    reason:
      "reads a remote https Parquet in-worker — DuckDB-WASM httpfs is OFF; fetch via the trusted core (§6a) or route to Docker",
  },
  {
    pattern: /['"](?:s3|s3a|gs|gcs|az|azure|abfss?):\/\//i,
    reason:
      "reads a remote object-store URL (s3://…) in-worker — no httpfs/egress in the worker; fetch via the trusted core (§6a) or route to Docker",
  },
  {
    pattern: /\bINSTALL\s+httpfs\b/i,
    reason:
      "INSTALL httpfs — the DuckDB-WASM build ships without httpfs and instantiates no fetch bridge; remote reads go through the trusted core (§6a)",
  },
];

/**
 * Scan generated Python for features the WASM tier can't serve. Pure regex — a
 * best-effort UX router, deliberately over-inclusive (a false positive only
 * routes an analysis to Docker; a miss dead-ends a no-Docker user), never the
 * security boundary. Returns the matched import names + a reason per finding.
 */
export function detectUnsupportedFeatures(code: string): UnsupportedFeatures {
  const imports: string[] = [];
  const reasons: string[] = [];

  for (const { name, reason } of UNSUPPORTED_IMPORTS) {
    // A real import of the package: `import statsmodels...` / `from statsmodels...`.
    if (new RegExp(`\\b(?:import|from)\\s+${name}\\b`).test(code)) {
      imports.push(name);
      reasons.push(reason);
    }
  }

  for (const { pattern, reason } of REMOTE_READS) {
    if (pattern.test(code)) {
      reasons.push(reason);
    }
  }

  return { imports, reasons };
}
