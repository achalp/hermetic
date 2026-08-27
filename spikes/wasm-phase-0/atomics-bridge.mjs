// Phase 1b-shim de-risk — the sync/async bridge MECHANISM (spec §6-A).
//
// The hard problem the reviews flagged: generated Python calls
// `duckdb.sql(q).df()` SYNCHRONOUSLY, but DuckDB-WASM is async. Strategy A is
// SharedArrayBuffer + Atomics.wait: the Python-side worker BLOCKS on a SAB while
// an async DuckDB call runs in a second worker and signals completion.
//
// This proves the mechanism: a "synchronous" call in worker A blocks until
// worker B finishes an ASYNC task and Atomics.notify's — the exact handoff the
// shim needs. (In the browser this SAB path requires COOP/COEP cross-origin
// isolation — a 0(b) infra item; Node worker_threads support it natively, so the
// MECHANISM is what we prove here, decoupled from that browser infra.)
//
// Run: node spikes/wasm-phase-0/atomics-bridge.mjs
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);

if (isMainThread) {
  // ── Orchestrator: spin up the "DuckDB" async worker + the "Python" sync worker,
  //    wired by a shared control buffer (the SAB). ──
  const control = new SharedArrayBuffer(8); // [0]=flag, [1]=result length
  const data = new SharedArrayBuffer(4096); // the async result bytes land here
  const flag = new Int32Array(control);

  // The async "engine" worker: waits for a request flag, does async work, writes
  // the result into the data SAB, then Atomics.notify's the sync worker.
  const engine = new Worker(SELF, { workerData: { role: "engine", control, data } });

  // The "python" worker: makes a SYNCHRONOUS-looking call that internally sets the
  // request flag and Atomics.wait()s until the engine signals — never touching a
  // Promise or await.
  const py = new Worker(SELF, { workerData: { role: "python", control, data } });

  py.on("message", (m) => {
    console.log("── Atomics sync-bridge de-risk (spec §6-A) ──");
    console.log(m.log.join("\n"));
    console.log(
      m.ok
        ? "\nPASS ✓  a synchronous Python-side call blocked on Atomics.wait and got the\n" +
            "        async engine's result with NO await — the DuckDB-WASM shim's core\n" +
            "        sync/async handoff is feasible (browser needs COOP/COEP — 0b infra)."
        : "\nFAIL — bridge did not deliver the expected result."
    );
    engine.terminate();
    py.terminate();
    process.exit(m.ok ? 0 : 1);
  });
} else if (workerData.role === "engine") {
  const flag = new Int32Array(workerData.control);
  const data = new Uint8Array(workerData.data);
  const lenView = new Int32Array(workerData.control);
  // Poll for a request (flag[0] === 1), do genuinely-ASYNC work, then answer.
  const loop = async () => {
    for (;;) {
      // Wait asynchronously for a request without blocking this thread.
      const res = Atomics.waitAsync(flag, 0, 0);
      if (res.async) await res.value;
      if (Atomics.load(flag, 0) !== 1) continue;
      // Simulate an async DuckDB-WASM query (Promise-based, off-thread).
      const answer = await new Promise((r) =>
        setTimeout(() => r(JSON.stringify({ rows: 3, top: "west", revenue: 42117.5 })), 20)
      );
      const bytes = new TextEncoder().encode(answer);
      data.set(bytes, 0);
      Atomics.store(lenView, 1, bytes.length);
      Atomics.store(flag, 0, 2); // 2 = response ready
      Atomics.notify(flag, 0);
    }
  };
  loop();
} else if (workerData.role === "python") {
  const flag = new Int32Array(workerData.control);
  const data = new Uint8Array(workerData.data);
  const lenView = new Int32Array(workerData.control);
  const log = [];

  // This function LOOKS synchronous — no async/await — exactly like the Python
  // `duckdb.sql(q).df()` the generated code calls.
  function querySync(sql) {
    log.push(`  [python] querySync(${JSON.stringify(sql)}) — no await`);
    Atomics.store(flag, 0, 1); // 1 = request
    Atomics.notify(flag, 0);
    // BLOCK this thread until the async engine signals (flag → 2).
    Atomics.wait(flag, 0, 1);
    const len = Atomics.load(lenView, 1);
    const out = new TextDecoder().decode(data.slice(0, len));
    log.push(`  [python] blocked on Atomics.wait, got result synchronously: ${out}`);
    return JSON.parse(out);
  }

  const t = Date.now();
  const r = querySync("SELECT region, SUM(price) revenue FROM t GROUP BY 1 ORDER BY 2 DESC");
  log.push(`  [python] round-trip ${Date.now() - t}ms; parsed rows=${r.rows}, top=${r.top}`);
  const ok = r.rows === 3 && r.top === "west" && r.revenue === 42117.5;
  parentPort.postMessage({ ok, log });
}
