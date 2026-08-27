/**
 * Phase 1b-shim (spec §6 / §6-A) — the REAL @duckdb/duckdb-wasm engine behind the
 * synchronous/async {@link createDuckDbBridge} seam. This is the concrete engine the
 * bridge's doc-comment promised ("a later phase supplies it"): a self-contained async
 * `(sql) => Promise<DuckDbResult>` whose SOURCE is shipped into the bridge's spawned
 * engine worker via `.toString()`, where it boots a real DuckDB-WASM instance, runs
 * the SQL, and maps the Arrow result to `{ columns, rows }`.
 *
 * ── TOPOLOGY: blocking DuckDB-WASM IN the bridge's engine worker (no nesting) ──
 * The bridge ships this engine's source into ONE worker it owns and blocks the caller
 * on `Atomics.wait` until that worker answers. The engine therefore runs INSIDE that
 * worker. We deliberately use the **`@duckdb/duckdb-wasm/blocking` Node bundle**
 * (`createDuckDB` + `NODE_RUNTIME`), which runs the WASM module IN-PROCESS on the
 * calling thread — it needs NO worker of its own. That makes the whole system exactly
 * TWO threads: the caller and the bridge's engine worker. We reuse the bridge unchanged
 * (the task's preferred outcome) and never nest workers.
 *
 * Why NOT `AsyncDuckDB` (the async Node bundle), despite the task naming it: it drives
 * the WASM module from a SECOND worker it spawns itself. Placed inside the bridge's
 * engine worker that becomes a NESTED worker_threads chain — the exact fragility the
 * bridge doc-comment flags (an idle nested worker; §6 "PE F2"). Worse, its Node worker
 * requires the `web-worker` polyfill: the package's own `createWorker()` helper hands
 * the polyfill a `blob:` URL (via `fetch`→`URL.createObjectURL`), but the polyfill's
 * Node path only accepts `file:`/path/`data:` URLs (`fileURLToPath`), so `createWorker`
 * throws `ERR_INVALID_URL_SCHEME` under Node — it is effectively browser-only. Even
 * with `web-worker` wired up by hand the worker aborts with `ReferenceError: module is
 * not defined` from its Emscripten glue. The blocking bundle sidesteps all of it and
 * runs the identical DuckDB SQL engine, so it is the working topology (task §2/§6).
 * Wrapping its synchronous `conn.query` in this `async` function satisfies the bridge's
 * `(sql) => Promise<DuckDbResult>` contract without pretense.
 *
 * ── SELF-CONTAINMENT (hard constraint) ──
 * The bridge rebuilds this function from `duckdbEngine.toString()` via indirect eval in
 * a plain CommonJS worker. So the function body may NOT close over ANYTHING in this
 * module — no imports, no module-scope helpers, no constants. Every dependency is
 * pulled with the worker's own `require` (grabbed via `(0, eval)("require")` so the
 * bundler cannot rewrite it) and every helper is defined INSIDE the body. `@duckdb/
 * duckdb-wasm` is required DYNAMICALLY here (never statically imported) so it stays out
 * of the production bundle — it is a dev/integration dependency only.
 *
 * The DuckDB instance + connection are memoized on `globalThis` so the ~one-time WASM
 * instantiation happens on the first query and every later query on the same bridge
 * reuses them (the engine worker, and thus this global, lives for the bridge's life).
 *
 * Coverage: this file is an INTEGRATION edge (it boots the WASM runtime) — it is on the
 * vitest coverage exclude list next to executor.ts / transport-node.ts / duckdb-bridge.ts
 * and is pinned by the real end-to-end test in __tests__/duckdb-engine.test.ts, not by
 * unit coverage.
 */
import type { DuckDbResult } from "./contract";
import type { DuckDbEngine } from "./duckdb-bridge";

/**
 * A real DuckDB-WASM engine, shaped to the bridge's {@link DuckDbEngine} seam.
 *
 * MUST stay self-contained: its `.toString()` is shipped into the bridge's engine
 * worker and rebuilt with indirect eval, so it may reference only its own parameters,
 * things it `require`s at runtime, and helpers defined within its own body. Pass it
 * straight to `createDuckDbBridge(duckdbEngine)`.
 */
export const duckdbEngine: DuckDbEngine = async function duckdbEngine(
  sql: string
): Promise<DuckDbResult> {
  // Grab the worker's genuine CommonJS require, bypassing any bundler rewrite of a
  // literal `require(...)` (this source is eval'd inside the bridge worker).

  const req: NodeRequire = (0, eval)("require");
  // This fn is .toString()-shipped into the bridge worker, so module scope can't
  // persist the memoized DB connection across queries; globalThis is the only
  // per-worker singleton available here.
  const g = globalThis as unknown as {
    // ratchet-allow: lib-globalthis-stores
    __hermeticDuckDbBlocking?: Promise<{ conn: { query(sql: string): unknown } }>;
  };

  // Boot the real WASM engine ONCE (in-process, blocking bundle — no worker of its
  // own). Memoized so every later query on this bridge reuses the same connection.
  if (!g.__hermeticDuckDbBlocking) {
    g.__hermeticDuckDbBlocking = (async () => {
      const path = req("node:path");
      // Dynamic require — keeps @duckdb/duckdb-wasm OUT of the production bundle.
      const entry = "@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs";
      const duckdb = req(entry);
      const distDir = path.dirname(req.resolve(entry));
      const bundles = {
        mvp: {
          mainModule: path.join(distDir, "duckdb-mvp.wasm"),
          mainWorker: path.join(distDir, "duckdb-node-mvp.worker.cjs"),
        },
        eh: {
          mainModule: path.join(distDir, "duckdb-eh.wasm"),
          mainWorker: path.join(distDir, "duckdb-node-eh.worker.cjs"),
        },
      };
      const db = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
      await db.instantiate();
      return { conn: db.connect() };
    })();
  }

  const { conn } = await g.__hermeticDuckDbBlocking;

  // ── Arrow → JSON-safe DuckDbResult mapping (all helpers inline for self-containment) ──

  // Convert one Arrow cell into a value that JSON.stringify (which the bridge runs)
  // can serialize. Critically, BigInt is not JSON-serializable and would throw in the
  // bridge worker, so it is converted here; nested lists/structs recurse.
  const normalize = (v: unknown): unknown => {
    if (v === null || v === undefined) return null;
    const t = typeof v;
    if (t === "bigint") {
      const n = Number(v as bigint);
      return Number.isSafeInteger(n) ? n : (v as bigint).toString();
    }
    if (t === "number" || t === "string" || t === "boolean") return v;
    if (v instanceof Date) return v.toISOString();
    if (ArrayBuffer.isView(v)) {
      // DuckDB DECIMALs arrive as a Uint32Array subclass (DecimalBigNum) whose
      // toString() yields the UNSCALED integer; scaled values are handled at the
      // column level (see below). A view reaching here is treated as raw bytes.
      const ctorName = (v as { constructor?: { name?: string } }).constructor?.name ?? "";
      if (ctorName === "DecimalBigNum") {
        const n = Number((v as { toString(): string }).toString());
        return Number.isFinite(n) ? n : (v as { toString(): string }).toString();
      }
      return Array.from(v as unknown as ArrayLike<number>, (b) => normalize(b));
    }
    if (Array.isArray(v)) return v.map(normalize);
    if (t === "object") {
      const src = v as { toJSON?: () => unknown };
      if (typeof src.toJSON === "function") return normalize(src.toJSON());
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>)) {
        out[k] = normalize((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return String(v);
  };

  // Apply a DECIMAL column's scale to its unscaled integer text, preserving digits.
  const scaleDecimal = (value: unknown, scale: number): unknown => {
    let text = String((value as { toString(): string }).toString());
    if (scale <= 0) {
      const n = Number(text);
      return Number.isSafeInteger(n) ? n : text;
    }
    const neg = text.startsWith("-");
    if (neg) text = text.slice(1);
    text = text.padStart(scale + 1, "0");
    const cut = text.length - scale;
    const composed = (neg ? "-" : "") + text.slice(0, cut) + "." + text.slice(cut);
    const n = Number(composed);
    return Number.isFinite(n) ? n : composed;
  };

  const mapTable = (table: {
    schema: { fields: { name: unknown; type: { scale?: number } }[] };
    toArray(): { toJSON(): Record<string, unknown> }[];
  }): DuckDbResult => {
    const fields = table.schema.fields;
    const columns = fields.map((f) => String(f.name));
    const rows = table.toArray().map((row) => {
      const record = row.toJSON();
      return fields.map((f) => {
        const cell = record[String(f.name)];
        if (cell != null && ArrayBuffer.isView(cell) && typeof f.type?.scale === "number") {
          return scaleDecimal(cell, f.type.scale);
        }
        return normalize(cell);
      });
    });
    return { columns, rows };
  };

  // Run the (possibly multi-statement) SQL. The blocking connection executes all
  // statements and returns the Arrow table of the LAST one.
  const table = conn.query(sql) as Parameters<typeof mapTable>[0];
  return mapTable(table);
};
