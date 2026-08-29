// Pre-cache the numpy/pandas Pyodide wheels into node_modules/pyodide so the
// browser-analysis e2e (e2e/wasm-browser-analysis.spec.ts) can serve them LOCALLY
// (no CDN in the browser). Pyodide's Node loadPackage fetches once from the CDN
// and caches the .whl next to the runtime; the e2e then serves those files.
// Run in CI before playwright. Idempotent (a cached wheel is reused).
import { loadPyodide } from "pyodide";

const py = await loadPyodide();
await py.loadPackage(["numpy", "pandas"]);
const v = py.runPython(
  "import numpy, pandas; f'numpy {numpy.__version__}, pandas {pandas.__version__}'"
);
console.log("cached wheels:", v);
