/**
 * The ONE in-process DuckDB the host uses when there is no Docker (build log
 * D25). Boots `@duckdb/duckdb-wasm`'s **node-blocking** bundle with
 * `NODE_RUNTIME`, so it reads the real filesystem synchronously on the calling
 * thread: no container, no worker, no network.
 *
 * Extracted from `parquet-convert.ts` (D12), which booted this itself. Two
 * callers now need it — parquet→CSV materialization and host-side parquet schema
 * extraction — and a second boot would mean a second ~40 MB WASM instantiation
 * for no gain, so the connection is memoized at module scope.
 *
 * Booted via `createRequire` (ESM-safe) rather than reusing `duckdb-engine`: that
 * engine's `eval("require")` only resolves once its source is shipped into a CJS
 * worker, so it cannot be called directly here.
 *
 * NOTE: this bundle's HTTP path is inert in Node — it issues no requests. That is
 * a property we rely on, not an accident: everything here reads LOCAL paths, and
 * remote reads must go through the Rust egress core instead.
 *
 * Integration edge (DuckDB-WASM) → coverage-excluded; covered by gated
 * integration tests (HERMETIC_WASM_TEST).
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hermeticPaths } from "@/lib/paths";

/**
 * The bundle candidates present in `distDir`, preferred first. A full
 * node_modules install has mvp+eh; the .mcpb vendors ONLY eh (the mvp module
 * is 41 MB of fallback for pre-wasm-EH engines no supported Node needs) — so
 * candidates are filtered by what actually exists rather than hardcoded.
 * Exported for tests; throws when the dist has neither (a truncated vendor
 * must fail loudly at boot, not as a cryptic instantiate error).
 */
export function availableDuckDbBundles(
  distDir: string
): Record<string, { mainModule: string; mainWorker: string }> {
  const candidates = {
    eh: {
      mainModule: join(distDir, "duckdb-eh.wasm"),
      mainWorker: join(distDir, "duckdb-node-eh.worker.cjs"),
    },
    mvp: {
      mainModule: join(distDir, "duckdb-mvp.wasm"),
      mainWorker: join(distDir, "duckdb-node-mvp.worker.cjs"),
    },
  };
  const present = Object.fromEntries(
    Object.entries(candidates).filter(([, b]) => existsSync(b.mainModule))
  );
  if (Object.keys(present).length === 0) {
    throw new Error(
      `No DuckDB-WASM node bundle found under ${distDir} — the dist is missing or truncated`
    );
  }
  return present;
}

/** The blocking connection's surface, narrowed to what we actually call. */
export interface HostDuckDbConn {
  query(sql: string): unknown;
}

let connPromise: Promise<HostDuckDbConn> | null = null;

export async function hostDuckDb(): Promise<HostDuckDbConn> {
  if (!connPromise) {
    connPromise = (async () => {
      const entry = "@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs";
      // Dynamic require keeps @duckdb/duckdb-wasm OUT of the client bundle. The
      // MODULE load works everywhere (serverExternalPackages hands it to real
      // node require) — but `require.resolve(entry)` does NOT: under Turbopack
      // dev it returns the bundler's module-ID string, and dirname() of that
      // produced the `[externals]/…` ENOENT that killed the first live wasm
      // remote question (D38). The wasm FILE paths therefore come from
      // hermeticPaths, same pattern as pyodideDir.
      const require = createRequire(import.meta.url);
      const duckdb = require(entry);
      const bundles = availableDuckDbBundles(hermeticPaths.duckdbNodeDistDir());
      const db = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
      await db.instantiate();
      return db.connect() as HostDuckDbConn;
    })();
  }
  return connPromise;
}

/** The Arrow table shape we consume — `toArray()` rows expose `toJSON()`. */
interface ArrowTable {
  toArray(): { toJSON(): Record<string, unknown> }[];
}

/** Run `sql` and return its rows as plain objects. */
export async function hostQueryRows(sql: string): Promise<Record<string, unknown>[]> {
  const conn = await hostDuckDb();
  const table = conn.query(sql) as ArrowTable;
  return table.toArray().map((r) => r.toJSON());
}

/** Run `sql` for its effect only (COPY, SET, …). */
export async function hostExec(sql: string): Promise<void> {
  const conn = await hostDuckDb();
  conn.query(sql);
}

/** Test-only: drop the memoized connection. */
export function _resetHostDuckDbForTests(): void {
  connPromise = null;
}
