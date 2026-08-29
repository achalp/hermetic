/**
 * Phase 1b-shim (spec §6 / §6-A) — the SYNCHRONOUS/async DuckDB bridge mechanism.
 *
 * The hard problem the PE reviews flagged (§6 "PE F2"): the generated analysis
 * code calls `duckdb.sql(q).df()` **synchronously** (pandas-style — the model's
 * memory-safety contract, prompts.ts:372-378), but a real DuckDB-WASM engine is
 * **async/Promise-based**. A synchronous Python call cannot `await` a JS Promise.
 * Strategy A (§6, the recommended path): the caller BLOCKS on a `SharedArrayBuffer`
 * via `Atomics.wait` while the async engine runs in a SECOND worker and signals
 * completion with `Atomics.notify`. This productionizes the proven spike at
 * spikes/wasm-phase-0/atomics-bridge.mjs — generalized and typed.
 *
 * This module is the MECHANISM only. The real @duckdb/duckdb-wasm engine is out of
 * scope here (a later phase supplies it, §6/§7 packaging): the engine is a PLUGGABLE
 * injected async function `(sql) => Promise<DuckDbResult>` that runs in the second
 * worker. Proving the sync↔async handoff against a stand-in async engine is exactly
 * what de-risks the shim before the WASM build lands.
 *
 * Topology (mirrors the spike + transport-node.ts's worker seam):
 *   - `createDuckDbBridge(engine)` runs on the CALLER thread (the Pyodide/exec
 *     worker in prod; the test's own thread here). It spawns a dedicated ENGINE
 *     worker, shipping the engine's SOURCE (`.toString()`) because worker_threads
 *     cannot clone a live function — so the injected engine MUST be self-contained
 *     (no closure), the same constraint transport-node.ts puts on its worker body.
 *   - `querySync(sql)` posts the request to the engine worker, then BLOCKS the caller
 *     thread on `Atomics.wait` until the engine worker frames a response into shared
 *     memory and notifies back. No async/await touches the caller — that is the
 *     entire point (it models the synchronous Python call).
 *   - The engine worker never blocks: it services requests on its normal event loop
 *     (a `message` listener) so its loop stays free to `await engine(sql)`.
 *
 * SAB FRAMING CHOICE (documented per the task) — a HYBRID: **request over the worker
 * message channel, response over the SAB**. The two directions are asymmetric:
 *   - REQUEST (caller → engine): `worker.postMessage(sql)`. The caller is still
 *     running when it sends, so an ordinary message is fine — and a live `message`
 *     listener keeps the engine worker's event loop alive to receive it. (Driving the
 *     request through the SAB with `Atomics.waitAsync` was the first cut; an
 *     outstanding `waitAsync` does NOT ref the engine worker's loop, so a NESTED
 *     engine worker idled out after one query — the message channel is the robust
 *     path and removes any per-request SAB size limit.)
 *   - RESPONSE (engine → caller): the caller is BLOCKED in `Atomics.wait`, so its
 *     event loop is frozen and it cannot receive a message; the answer must arrive
 *     through shared memory. The control buffer carries the wait/notify SIGNAL (a
 *     response counter) plus the status and payload byte-length; the data buffer
 *     carries the UTF-8 JSON of the DuckDbResult (or an error string). The SIZE GUARD
 *     falls straight out of the fixed data buffer: a response that does not fit is
 *     replaced by the engine worker with an error frame, so a huge result can never
 *     overrun the buffer — it surfaces as a thrown error instead.
 *
 * Node note (spec §6-A): Node's main AND worker threads support `SharedArrayBuffer`
 * + `Atomics.wait`/`Atomics.notify` natively — the COOP/COEP cross-origin-isolation
 * headers §6-A calls out are a BROWSER-only prerequisite for SAB, not a Node one. So
 * the MECHANISM is fully exercisable here, decoupled from that browser infra (which
 * Phase 0(b) proves separately).
 *
 * Dependency rule (scripts/isolation-check.mjs): wasm/ may reach @/lib/contracts/*,
 * node builtins, and its own files only. This is coverage-EXCLUDED integration glue
 * (vitest.config.ts); its guarantees are pinned by a real worker_threads +
 * SharedArrayBuffer + Atomics integration test, not by unit coverage.
 */
import { Worker } from "node:worker_threads";
import type { DuckDbBridge, DuckDbResult } from "./contract";

/** The pluggable async engine. Runs IN the engine worker, so it must be
 *  self-contained (no closure over the spawning scope) — its source is shipped via
 *  `.toString()`. A later phase passes a body that drives @duckdb/duckdb-wasm. */
export type DuckDbEngine = (sql: string) => Promise<DuckDbResult>;

export interface DuckDbBridgeOptions {
  /**
   * Capacity of the shared response DATA buffer in bytes. The size guard keys on
   * this: a response that does not fit is turned into an error frame rather than
   * overrunning the buffer. (Requests travel over the message channel and are not
   * bound by this.) Default 16 MiB.
   */
  maxResultBytes?: number;
  /**
   * Per-query wall-clock guard. Because the caller thread is BLOCKED in
   * `Atomics.wait`, it cannot observe an engine-worker crash via events while it
   * waits; this bounds the block so an unresponsive/dead engine worker surfaces as
   * a thrown timeout instead of an eternal deadlock. Default 30 s.
   */
  queryTimeoutMs?: number;
}

const DEFAULT_MAX_RESULT_BYTES = 16 * 1024 * 1024;
const DEFAULT_QUERY_TIMEOUT_MS = 30_000;

// ── Shared control-buffer layout (Int32 indices). Both sides MUST agree; the
//    engine harness below is generated with these exact numeric values. ──
const CTRL_INT32S = 4; // headroom; only the first three are used
const RES_SEQ = 0; //  engine bumps this per response; caller waits on it changing
const STATUS = 1; //   response status (STATUS_OK | STATUS_ERR)
const LEN = 2; //      response byte-length currently in the data buffer
const STATUS_OK = 1;
const STATUS_ERR = 2;

/**
 * The fixed ENGINE-WORKER harness (message/signal plumbing only — the engine BODY
 * rides in `workerData.engineSource` and is rebuilt via indirect eval, exactly like
 * transport-node.ts's replaceable worker body). Runs as CommonJS in an `eval:true`
 * worker. It receives each request on its normal event loop, `await`s the async
 * engine, then frames the result (or an error, or an over-cap-size error) into the
 * shared buffers and `Atomics.notify`s the blocked caller. The numeric constants are
 * injected so the two sides cannot drift.
 */
function engineHarnessSource(): string {
  return `
const { parentPort, workerData } = require("node:worker_threads");
const control = new Int32Array(workerData.control);
const data = new Uint8Array(workerData.data);
const cap = data.length;
const engine = (0, eval)("(" + workerData.engineSource + ")");
const enc = new TextEncoder();
const RES_SEQ=${RES_SEQ}, STATUS=${STATUS}, LEN=${LEN};
const STATUS_OK=${STATUS_OK}, STATUS_ERR=${STATUS_ERR};

parentPort.on("message", async (sql) => {
  let status = STATUS_OK;
  let out;
  try {
    const result = await engine(sql); // async DuckDB-WASM stand-in runs HERE
    out = enc.encode(JSON.stringify(result));
    if (out.length > cap) {
      status = STATUS_ERR;
      out = enc.encode("DuckDB result " + out.length + " bytes exceeds the " + cap + "-byte shared result buffer");
    }
  } catch (err) {
    status = STATUS_ERR;
    out = enc.encode(err && err.message ? String(err.message) : String(err));
  }
  if (out.length > cap) out = out.slice(0, cap); // last-ditch clamp (huge error text)

  data.set(out, 0);
  Atomics.store(control, LEN, out.length);
  Atomics.store(control, STATUS, status);
  Atomics.add(control, RES_SEQ, 1); // publish, then wake the blocked caller
  Atomics.notify(control, RES_SEQ);
});
`;
}

/**
 * Build a synchronous DuckDB bridge over an async engine. The returned
 * `DuckDbBridge.querySync` blocks the CALLER thread on `Atomics.wait` until the
 * engine worker answers — genuinely synchronous from the caller's view (no
 * async/await in its signature), modeling the Python `duckdb.sql(q).df()` call.
 *
 * `engine` MUST be self-contained (its source is shipped into the worker). It runs
 * in the spawned engine worker; a rejection/throw from it surfaces synchronously as
 * a thrown Error from `querySync`.
 */
export function createDuckDbBridge(
  engine: DuckDbEngine,
  opts: DuckDbBridgeOptions = {}
): DuckDbBridge {
  const cap = opts.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  const queryTimeoutMs = opts.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;

  const controlSab = new SharedArrayBuffer(CTRL_INT32S * Int32Array.BYTES_PER_ELEMENT);
  const dataSab = new SharedArrayBuffer(cap);
  const control = new Int32Array(controlSab);
  const data = new Uint8Array(dataSab);
  const dec = new TextDecoder();

  let disposed = false;
  let workerError: Error | null = null;
  // Read through a getter so TS control-flow narrowing does not collapse this
  // closure-mutated variable to `null` after an early guard.
  const currentWorkerError = (): Error | null => workerError;

  const worker = new Worker(engineHarnessSource(), {
    eval: true,
    workerData: {
      control: controlSab,
      data: dataSab,
      engineSource: engine.toString(),
    },
  });
  // A Worker with no 'error' listener rethrows in the parent and can crash it. Record
  // it instead — the caller is usually blocked in Atomics.wait when it fires, so the
  // per-query timeout is the primary safety net; this makes the reason available.
  worker.on("error", (err: Error) => {
    workerError = err;
  });
  // Keep the engine worker from holding the process open on its own; dispose() reaps
  // it. Its `message` listener keeps ITS OWN event loop alive between queries.
  worker.unref();

  function querySync(sql: string): DuckDbResult {
    if (disposed) throw new Error("DuckDbBridge has been disposed");
    const preErr = currentWorkerError();
    if (preErr) throw new Error(`DuckDB engine worker failed: ${preErr.message}`);

    // Send the request over the message channel, then BLOCK on the SAB for the
    // response the frozen caller loop cannot receive as a message.
    const prevRes = Atomics.load(control, RES_SEQ);
    worker.postMessage(sql);

    // Bounded by queryTimeoutMs so a dead engine worker cannot deadlock us forever.
    const deadline = Date.now() + queryTimeoutMs;
    while (Atomics.load(control, RES_SEQ) === prevRes) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const lateErr = currentWorkerError();
        if (lateErr) throw new Error(`DuckDB engine worker failed: ${lateErr.message}`);
        throw new Error(
          `DuckDB query timed out after ${queryTimeoutMs}ms (engine worker unresponsive)`
        );
      }
      Atomics.wait(control, RES_SEQ, prevRes, remaining);
    }

    const status = Atomics.load(control, STATUS);
    const len = Atomics.load(control, LEN);
    const text = dec.decode(data.slice(0, len));

    if (status === STATUS_ERR) throw new Error(text);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("DuckDB engine returned an unparseable result frame");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as DuckDbResult).columns) ||
      !Array.isArray((parsed as DuckDbResult).rows)
    ) {
      throw new Error(
        "DuckDB engine returned a malformed DuckDbResult (expected {columns[], rows[][]})"
      );
    }
    const result = parsed as DuckDbResult;
    return { columns: result.columns, rows: result.rows };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    void worker.terminate();
  }

  return { querySync, dispose };
}
