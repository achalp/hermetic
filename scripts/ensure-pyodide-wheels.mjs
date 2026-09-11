#!/usr/bin/env node
/**
 * Populate the Pyodide dist with the scientific-stack wheels (numpy, pandas,
 * scipy + their deps) BEFORE the sidecar copies it into a desktop bundle.
 *
 * The npm `pyodide` package ships the CORE runtime + lockfile only — wheels
 * download from the CDN on first `loadPackage` and are cached INTO the dist
 * dir. Dev machines that ever ran the Node parity tests had them; fresh CI
 * runners did not, so every packaged desktop app shipped a Pyodide that
 * could not `import pandas` offline (found via the mac sidecar.log,
 * v0.5.4: ModuleNotFoundError in the remote-schema worker). Booting Node
 * Pyodide here and loading the packages uses the EXACT lockfile the bundle
 * serves — no hand-maintained wheel list to drift.
 *
 * scipy is included because the Docker image ships it and generated analysis
 * code legitimately imports it; the worker loads it on demand (D39).
 */
import { readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "node_modules", "pyodide");

// matplotlib + scikit-learn joined scipy as on-demand loads (runtime parity
// with the Docker image); their wheels must ship in the desktop bundle too.
const WANT = ["numpy", "pandas", "scipy", "matplotlib", "scikit-learn"];

const have = () => {
  const files = readdirSync(DIST);
  // PEP 427 normalizes '-' to '_' in wheel filenames: the scikit-learn wheel
  // is scikit_learn-1.8.0-….whl, so match on the normalized spelling.
  return WANT.filter((p) => {
    const prefix = `${p.replace(/-/g, "_")}-`;
    return files.some((f) => f.replace(/-/g, "_").startsWith(prefix) && f.endsWith(".whl"));
  });
};

if (have().length === WANT.length) {
  console.log(`pyodide wheels present: ${WANT.join(", ")}`);
  process.exit(0);
}

console.log(`pyodide wheels missing (${WANT.filter((w) => !have().includes(w))}) — loading…`);
const { loadPyodide } = await import("pyodide");
const py = await loadPyodide();
await py.loadPackage(WANT);

const got = have();
if (got.length !== WANT.length) {
  console.error(
    `✖ wheels still missing after loadPackage: wanted [${WANT}], have [${got}] — ` +
      `a bundle built now would fail 'import pandas' offline`
  );
  process.exit(1);
}
console.log(`pyodide wheels cached into the dist: ${WANT.join(", ")}`);
