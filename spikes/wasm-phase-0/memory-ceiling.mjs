// Phase 0(a) VALUE GATE — how large a CSV can the WASM tier read + analyze?
//
// DuckDB-WASM is single-threaded with no disk-spill, and pandas is the OOM risk
// the reviews flagged. This measures the real read_csv → groupby path at growing
// sizes, recording WASM-heap peak + wall time, until it fails. The resulting
// ceiling is the go/no-go: does it cover normal personal datasets?
//
// Run: node --expose-gc spikes/wasm-phase-0/memory-ceiling.mjs
import { loadPyodide } from "pyodide";

const pyodide = await loadPyodide();
await pyodide.loadPackage(["numpy", "pandas"]);
pyodide.FS.mkdirTree("/data");

// A representative frame: 5 numeric + 2 short-string cols (~a real analytics CSV).
// Synthesize in-worker, to_csv into MEMFS, then read_csv it back + groupby —
// exercising the actual ingest+analyze path and its transient peak.
pyodide.runPython(`
import numpy as np, pandas as pd, gc, time
def make_csv(path, n_rows):
    rng = np.random.default_rng(0)
    df = pd.DataFrame({
        "cat": rng.integers(0, 500, n_rows),
        "region": rng.choice(["north","south","east","west","central"], n_rows),
        "sku": rng.choice([f"SKU{i:04d}" for i in range(2000)], n_rows),
        "qty": rng.integers(1, 100, n_rows),
        "price": rng.random(n_rows) * 1000,
        "cost": rng.random(n_rows) * 800,
        "discount": rng.random(n_rows),
    })
    df.to_csv(path, index=False)
    del df; gc.collect()

def analyze(path):
    # The read+aggregate path a generated analysis would run.
    t = time.time()
    df = pd.read_csv(path)
    g = df.groupby(["region","cat"]).agg(
        revenue=("price","sum"), units=("qty","sum"), avg_disc=("discount","mean")
    ).reset_index()
    top = g.sort_values("revenue", ascending=False).head(20)
    ms = (time.time()-t)*1000
    rows, cols = df.shape
    del df, g, top; gc.collect()
    return rows, cols, ms
`);

const heapMB = () => (pyodide._module.HEAP8.length / 1e6).toFixed(0);
const makeCsv = pyodide.globals.get("make_csv");
const analyze = pyodide.globals.get("analyze");

// ~75 bytes/row for this schema → rows for a target MB.
const BYTES_PER_ROW = 75;
const targetsMB = [5, 25, 50, 100, 200, 400];

console.log("── Phase 0(a) VALUE GATE: WASM memory ceiling (read_csv → groupby) ──");
console.log(`pyodide ${pyodide.version}  |  heap after wheels: ${heapMB()} MB\n`);
console.log("targetMB   rows      readCsv+groupby   wasm-heap-peak   verdict");

let lastOk = 0;
for (const mb of targetsMB) {
  const rows = Math.round((mb * 1e6) / BYTES_PER_ROW);
  const path = `/data/bench_${mb}.csv`;
  try {
    makeCsv(path, rows);
    const heapBefore = pyodide._module.HEAP8.length;
    const res = analyze(path);
    const [rRows, , ms] = res.toJs();
    res.destroy?.();
    const peak = Math.max(heapBefore, pyodide._module.HEAP8.length);
    pyodide.runPython(`import os; os.remove(${JSON.stringify(path)})`);
    console.log(
      `${String(mb).padEnd(9)}  ${String(rRows).padEnd(9)} ${ms.toFixed(0).padStart(10)} ms   ${String((peak / 1e6).toFixed(0)).padStart(9)} MB      OK`
    );
    lastOk = mb;
  } catch (e) {
    console.log(
      `${String(mb).padEnd(9)}  ${String(rows).padEnd(9)}          — FAILED at heap ${heapMB()} MB  (${String(e).slice(0, 80)})`
    );
    break;
  }
}
makeCsv.destroy?.();
analyze.destroy?.();
console.log(`\nHighest size that read+aggregated cleanly: ${lastOk} MB`);
console.log(
  lastOk >= 100
    ? "VERDICT: covers normal personal datasets (≥100MB). Value gate looks GREEN."
    : "VERDICT: ceiling below 100MB — value gate is marginal; reconsider or lean on DuckDB-WASM streaming."
);
