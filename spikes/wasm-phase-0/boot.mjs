// Phase 0(a) spike — Pyodide-in-Node feasibility + compute-parity (value gate).
//
// Proves: (1) Pyodide boots in Node; (2) the real hermetic_runtime package loads
// into MEMFS and imports; (3) the exact pure-math p-value machinery produces
// values IDENTICAL to host CPython (the strongest structural-parity claim, needs
// no wheels/network). Also reports cold-start latency + baseline memory.
//
// Run: node spikes/wasm-phase-0/boot.mjs
import { loadPyodide } from "pyodide";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";

const RUNTIME_DIR = "docker/sandbox/hermetic_runtime";

/** Recursively copy a host dir into Pyodide MEMFS under /data/<basename>/… */
function copyDirIntoMemfs(pyodide, hostDir, memfsRoot) {
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(hostDir, abs);
      const dest = `${memfsRoot}/${rel}`;
      if (statSync(abs).isDirectory()) {
        pyodide.FS.mkdirTree(dest);
        walk(abs);
      } else if (name.endsWith(".py")) {
        pyodide.FS.writeFile(dest, readFileSync(abs, "utf-8"));
      }
    }
  };
  pyodide.FS.mkdirTree(memfsRoot);
  walk(hostDir);
}

// Reference p-values from HOST CPython, computed with the SAME source module.
function hostReference() {
  const py = `
import sys; sys.path.insert(0, "${RUNTIME_DIR}/..")
from hermetic_runtime.findings import _betainc_reg, _t_p_two_sided, _t_crit_95, _f_p, _kw_p
import json
cases = {
  "betainc_reg(2,3,0.4)": _betainc_reg(2.0, 3.0, 0.4),
  "t_p_two_sided(2.1,10)": _t_p_two_sided(2.1, 10),
  "t_p_two_sided(0.5,4)": _t_p_two_sided(0.5, 4),
  "t_crit_95(10)": _t_crit_95(10),
  "t_crit_95(30)": _t_crit_95(30),
  "f_p(4.2,2,20)": _f_p(4.2, 2, 20),
  "kw_p([[1,2,3],[4,5,6],[2,2,9]])": _kw_p([[1,2,3],[4,5,6],[2,2,9]]),
}
print(json.dumps(cases))
`;
  return JSON.parse(execFileSync("python3", ["-c", py], { encoding: "utf-8" }));
}

const t0 = performance.now();
const pyodide = await loadPyodide();
const bootMs = performance.now() - t0;

copyDirIntoMemfs(pyodide, RUNTIME_DIR, "/data/hermetic_runtime");

const wasm = pyodide.runPython(`
import sys; sys.path.insert(0, "/data")
from hermetic_runtime.findings import _betainc_reg, _t_p_two_sided, _t_crit_95, _f_p, _kw_p
import json
json.dumps({
  "betainc_reg(2,3,0.4)": _betainc_reg(2.0, 3.0, 0.4),
  "t_p_two_sided(2.1,10)": _t_p_two_sided(2.1, 10),
  "t_p_two_sided(0.5,4)": _t_p_two_sided(0.5, 4),
  "t_crit_95(10)": _t_crit_95(10),
  "t_crit_95(30)": _t_crit_95(30),
  "f_p(4.2,2,20)": _f_p(4.2, 2, 20),
  "kw_p([[1,2,3],[4,5,6],[2,2,9]])": _kw_p([[1,2,3],[4,5,6],[2,2,9]]),
})
`);
const wasmVals = JSON.parse(wasm);
const hostVals = hostReference();

let maxAbsDiff = 0;
let allExact = true;
const rows = [];
for (const k of Object.keys(hostVals)) {
  const h = hostVals[k];
  const w = wasmVals[k];
  const diff = Math.abs(h - w);
  maxAbsDiff = Math.max(maxAbsDiff, diff);
  if (h !== w) allExact = false;
  rows.push(`  ${k.padEnd(34)} host=${h}  wasm=${w}  Δ=${diff}`);
}

const mem = process.memoryUsage();
console.log("── Phase 0(a) — Pyodide boot + p-value parity ──");
console.log(`pyodide version:     ${pyodide.version}`);
console.log(`cold-start (boot):   ${bootMs.toFixed(0)} ms`);
console.log(`RSS after boot:      ${(mem.rss / 1e6).toFixed(0)} MB`);
console.log("");
console.log(rows.join("\n"));
console.log("");
console.log(`max abs diff:        ${maxAbsDiff}`);
console.log(
  `bitwise-identical:   ${allExact ? "YES ✓ (exact CPython parity)" : "no — within tolerance below"}`
);
if (!allExact && maxAbsDiff > 1e-12) {
  console.error(`FAIL: parity diff ${maxAbsDiff} exceeds 1e-12`);
  process.exit(1);
}
console.log("\nPASS ✓  hermetic_runtime p-value machinery runs identically under Pyodide.");
