/**
 * DuckDB inside the execution worker (build log D18) — the piece that lets the
 * no-Docker tier run the DuckDB-shaped analysis code the model already writes.
 *
 * ── WHY THIS IS SYNCHRONOUS ALL THE WAY DOWN ──
 * Generated analysis code calls `duckdb.sql(q).df()` SYNCHRONOUSLY (prompts.ts's
 * memory-safety contract). We use the **blocking** browser build, whose I/O is
 * synchronous XHR — measured in D18 to work in a classic worker under the
 * production CSP (206 + exact byte counts). Sync XHR is banned on the main thread
 * but legal in a worker, which is precisely where we are. So the chain
 *
 *     Python (sync) → Pyodide FFI (sync) → DuckDB C++/WASM (sync) → XHR (sync)
 *
 * never crosses a promise, and the SharedArrayBuffer + `Atomics.wait` bridge
 * (duckdb-bridge.ts) is NOT needed here — that machinery exists only to make an
 * ASYNC engine answer a sync caller. No SAB also means no COOP/COEP requirement.
 *
 * ── ASSETS ARE SAME-ORIGIN, INCLUDING EXTENSIONS ──
 * `connect-src 'self'` blocks DuckDB's default extension repository
 * (extensions.duckdb.org) — D18 caught that as a sync XHR failing with status 0.
 * We serve a local repository at /duckdb/ext and point BOTH
 * `custom_extension_repository` and `autoinstall_extension_repository` at it, so
 * parquet/httpfs load with the CSP unchanged.
 *
 * ── REMOTE READS ──
 * A remote source is registered by the SIDECAR as a token-scoped
 * `/api/wasm-range/<token>` URL. The worker's httpfs reads it by byte range; the
 * worker chooses OFFSETS, never a destination (see range-registry.ts). Generated
 * code never sees the upstream URL — it queries the same-origin alias.
 */

/** The wasm module + glue we ship (mvp: the eh module traps against this glue — D18). */
export const DUCKDB_BUNDLE_FILE = "duckdb-bundle.js";
export const DUCKDB_WASM_FILE = "duckdb-mvp.wasm";

/**
 * STATIC worker-side boot code, embedded once in the worker source. It takes its
 * parameters as DATA at call time (`base`, `aliases` from the request) rather than
 * being generated per-run — the worker CSP allows `wasm-unsafe-eval` but NOT
 * `unsafe-eval`, so per-request JS could never be eval'd. Nothing here closes over
 * the module; it is embedded as text.
 *
 * Installs `self.__hermeticDuckQuery(sql) -> json text`, the single entry point
 * the Python shim calls.
 */
export const DUCKDB_BOOT_FN_SOURCE = `
async function __hermeticBootDuckDb(base, aliases) {
  importScripts(base + ${JSON.stringify(DUCKDB_BUNDLE_FILE)});
  const duck = self.DuckDBB;
  const db = await duck.createDuckDB(
    { mvp: { mainModule: base + ${JSON.stringify(DUCKDB_WASM_FILE)}, mainWorker: null } },
    new duck.VoidLogger(),
    duck.BROWSER_RUNTIME
  );
  await db.instantiate();
  const conn = db.connect();
  // Same-origin extension repository. DuckDB's built-in default points at a public
  // CDN, which connect-src 'self' correctly blocks (D18 measured it as status 0),
  // so both repository settings are redirected here before any autoload happens.
  const repo = new URL(base + "ext", self.location.origin).href;
  conn.query("SET custom_extension_repository='" + repo + "'");
  conn.query("SET autoinstall_extension_repository='" + repo + "'");
  conn.query("INSTALL parquet"); conn.query("LOAD parquet");
  // httpfs only when a remote source is registered: it is a separate extension
  // download, and a local-file run should not pay for it.
  if (aliases && aliases.length > 0) {
    conn.query("INSTALL httpfs"); conn.query("LOAD httpfs");
    for (const a of aliases) {
      const href = new URL(a.url, self.location.origin).href;
      // directIO=true → httpfs issues RANGE reads. With false, duckdb buffers the
      // WHOLE object (D18: 525MB / 14.5s for what ranges answered in 828ms).
      db.registerFileURL(a.name, href, duck.DuckDBDataProtocol.HTTP, true);
    }
  }
  self.__hermeticDuckQuery = (sql) => conn.query(String(sql)).toString();
}
`;

/**
 * Does this generated code need the DuckDB engine booted? Booting costs a 41MB
 * wasm module, so a pandas-only run must not pay for it. Matched as a real import
 * statement, mirroring how prelude.ts detects unsupported packages.
 */
export function codeNeedsDuckDb(code: string): boolean {
  return /\b(?:import|from)\s+duckdb\b/.test(code);
}

/**
 * Python that makes `import duckdb` work against the JS engine above. Implements
 * the surface the generated code actually uses — `sql`/`query`/`execute`, then
 * `.df()`/`.fetchall()`/`.fetchone()` on the result — and nothing more, so an
 * unsupported call fails loudly instead of silently returning something wrong.
 */
export const DUCKDB_PY_SHIM = `
import sys as _sys, json as _json, types as _types
import js as _js

class _DuckResult:
    """Rows from one query. Materialized eagerly: the engine call is synchronous
    and the result already crossed the FFI boundary as JSON."""
    def __init__(self, rows):
        self._rows = rows

    def df(self):
        import pandas as _pd
        return _pd.DataFrame(self._rows)

    # DuckDB's own alias for df()
    to_df = df

    def fetchall(self):
        return [tuple(r.values()) for r in self._rows]

    def fetchone(self):
        return tuple(self._rows[0].values()) if self._rows else None

    def fetchdf(self):
        return self.df()

    def __len__(self):
        return len(self._rows)

def _run(sql, *_a, **_k):
    raw = _js.__hermeticDuckQuery(str(sql))
    # The engine returns Arrow's JSON rendering: a list of row objects.
    rows = _json.loads(raw) if raw else []
    if not isinstance(rows, list):
        rows = []
    return _DuckResult(rows)

_duckdb = _types.ModuleType("duckdb")
_duckdb.sql = _run
_duckdb.query = _run
_duckdb.execute = _run

class _Conn:
    """duckdb.connect() returns something query-shaped; there is exactly ONE
    underlying connection (the worker's), so this is a thin facade."""
    def sql(self, q, *a, **k): return _run(q)
    def query(self, q, *a, **k): return _run(q)
    def execute(self, q, *a, **k): return _run(q)
    def close(self): pass

_duckdb.connect = lambda *a, **k: _Conn()
_sys.modules["duckdb"] = _duckdb
`;
