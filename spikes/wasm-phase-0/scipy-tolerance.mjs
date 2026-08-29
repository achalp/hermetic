// Phase 0(a) — numpy/scipy compute-parity tolerance (WASM vs native).
// The reviews noted BLAS differs native-vs-WASM, so these are "within tolerance",
// not exact (unlike the pure-math p-values). This quantifies the tolerance on the
// scipy/numpy functions hermetic_runtime uses opportunistically (pearsonr,
// spearmanr, f_oneway, kruskal) + representative numpy aggregates, on a FIXED
// dataset, diffed against host CPython (numpy 2.2.4 / scipy 1.15.2 — the pinned
// Docker stack). Run: node spikes/wasm-phase-0/scipy-tolerance.mjs
import { loadPyodide } from "pyodide";
import { execFileSync } from "node:child_process";

// Identical fixed program run in both engines; emits a JSON dict of scalars.
const PROG = `
import numpy as np, json
from scipy import stats
rng = np.random.default_rng(42)
x = rng.normal(0, 1, 2000)
y = 0.7 * x + rng.normal(0, 0.5, 2000)
g1 = rng.normal(10, 2, 500); g2 = rng.normal(11, 2, 500); g3 = rng.normal(9.5, 2, 500)
pear = stats.pearsonr(x, y); spear = stats.spearmanr(x, y)
f = stats.f_oneway(g1, g2, g3); kw = stats.kruskal(g1, g2, g3)
out = {
  "numpy_ver": np.__version__,
  "mean": float(x.mean()), "std": float(x.std()), "median": float(np.median(y)),
  "p25": float(np.percentile(y, 25)), "p75": float(np.percentile(y, 75)),
  "pearson_r": float(pear[0]), "pearson_p": float(pear[1]),
  "spearman_r": float(spear.statistic), "spearman_p": float(spear.pvalue),
  "anova_F": float(f.statistic), "anova_p": float(f.pvalue),
  "kruskal_H": float(kw.statistic), "kruskal_p": float(kw.pvalue),
}
print(json.dumps(out))
`;

const host = JSON.parse(execFileSync("python3", ["-c", PROG], { encoding: "utf-8" }));

const pyodide = await loadPyodide();
await pyodide.loadPackage(["numpy", "scipy"]);
const wasm = JSON.parse(
  pyodide.runPython(PROG.replace("print(json.dumps(out))", "json.dumps(out)"))
);

console.log("── numpy/scipy parity: WASM vs native (Docker-pinned) ──");
console.log(`host  numpy ${host.numpy_ver} / scipy 1.15.2`);
console.log(`wasm  numpy ${wasm.numpy_ver} / scipy (pyodide)\n`);
console.log("metric          host                wasm                rel-diff");
let maxRel = 0;
for (const k of Object.keys(host)) {
  if (k === "numpy_ver") continue;
  const h = host[k],
    w = wasm[k];
  const rel = h === 0 ? Math.abs(w) : Math.abs(h - w) / Math.abs(h);
  maxRel = Math.max(maxRel, rel);
  console.log(
    `${k.padEnd(14)} ${String(h).padEnd(19)} ${String(w).padEnd(19)} ${rel.toExponential(2)}`
  );
}
console.log(`\nmax relative diff: ${maxRel.toExponential(3)}`);
const TOL = 1e-6;
console.log(
  maxRel <= TOL
    ? `PASS ✓  within ${TOL} — numpy/scipy parity holds despite version + BLAS differences.`
    : `NOTE: max rel diff ${maxRel.toExponential(2)} exceeds ${TOL} — parity gate must use this tolerance, not bitwise.`
);
