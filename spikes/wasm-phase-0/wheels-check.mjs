import { loadPyodide } from "pyodide";
const t0 = performance.now();
const pyodide = await loadPyodide();
console.log(`boot: ${(performance.now() - t0).toFixed(0)}ms`);
try {
  const t1 = performance.now();
  await pyodide.loadPackage(["numpy", "pandas"]);
  console.log(`loadPackage(numpy,pandas): ${(performance.now() - t1).toFixed(0)}ms`);
  const v = pyodide.runPython(`
import numpy, pandas
f"numpy {numpy.__version__}, pandas {pandas.__version__}"
`);
  console.log("LOADED:", v);
  console.log("RSS after wheels:", (process.memoryUsage().rss / 1e6).toFixed(0), "MB");
} catch (e) {
  console.error("WHEEL LOAD FAILED (likely no network to Pyodide CDN):", String(e).slice(0, 300));
  process.exit(3);
}
