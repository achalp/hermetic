/**
 * The `wasm` sandbox executor — Pyodide (CPython-on-WASM) in a Node worker.
 * Phase 1a: CI/parity-only and flag-gated (the capability gate REJECTS every
 * `wasm` run for real users until the §7 escape suite lands — capabilities.ts).
 * This runner exists so the compute path + the ExecutionResult contract can be
 * hardened in CI against the SAME hermetic_runtime the Docker path ships.
 *
 * `pyodide` is a devDependency and is imported DYNAMICALLY here, so the production
 * bundle never pulls it in; only a caller that actually invokes the wasm executor
 * (tests / a future flag-gated path) loads it.
 *
 * Isolation caveat (why this is CI-only): Node-Pyodide's `import js` FFI reaches
 * the Node global (process/require) — it is NOT the browser-sandbox boundary the
 * real user path uses (spec §4 Option A vs B). This runner must never be handed
 * untrusted user data over a network; it runs fixtures.
 */
import { dirname } from "node:path";
import { parseSandboxOutput } from "../parse-output";
import { hermeticRuntimeFiles } from "../runtime-files";
import type { ExecutionResult, AdditionalFile } from "@/lib/contracts/execution";

const WORK_DIR = "/data";

// Minimal WASM-safe prelude — the Docker prelude's daemon threads / cgroup guards
// / os.environ proxy plumbing don't exist in WASM (spec §5). Keep only the
// stdlib-safe bits the output contract needs: sys.path for hermetic_runtime, and
// json allow_nan so write_output can emit NaN/Infinity.
const WASM_PRELUDE = `
import sys, json
sys.path.insert(0, "${WORK_DIR}")
_orig_dump, _orig_dumps = json.dump, json.dumps
json.dump = lambda obj, fp, **kw: _orig_dump(obj, fp, **{**kw, "allow_nan": True})
json.dumps = lambda obj, **kw: _orig_dumps(obj, **{**kw, "allow_nan": True})
`;

// One Pyodide instance per process, lazily booted + kept warm; packages loaded
// once. Dynamic import keeps `pyodide` out of the production bundle.
type Pyodide = Awaited<ReturnType<typeof loadPyodideLazy>>;
let pyodidePromise: Promise<Pyodide> | null = null;

async function loadPyodideLazy() {
  const { loadPyodide } = await import("pyodide");
  const py = await loadPyodide();
  await py.loadPackage(["numpy", "pandas"]);
  return py;
}
function getPyodide(): Promise<Pyodide> {
  return (pyodidePromise ??= loadPyodideLazy());
}

/** Reset the cached instance (tests that need a clean process-level runtime). */
export function _resetWasmRuntimeForTests(): void {
  pyodidePromise = null;
}

export interface WasmExecOptions {
  additionalFiles?: AdditionalFile[];
  geojsonContent?: string | null;
}

/**
 * Run `code` over `csvContent` in Pyodide and return the parsed ExecutionResult.
 * Matches the docker executor's entrypoint shape: (csvContent, code, opts).
 */
export async function executeSandbox(
  csvContent: string,
  code: string,
  opts: WasmExecOptions = {}
): Promise<ExecutionResult> {
  const py = await getPyodide();
  const start = Date.now();

  // Fresh /data every run (the warm-pool cleanup invariant — spec §8/F7).
  py.runPython(
    `import shutil, os; shutil.rmtree("${WORK_DIR}", ignore_errors=True); os.makedirs("${WORK_DIR}", exist_ok=True)`
  );

  // Stage the runtime package (the SAME files the Docker path attaches, absolute
  // /data/hermetic_runtime/* paths), plus caller-supplied files and the input CSV.
  const files: AdditionalFile[] = [...hermeticRuntimeFiles(), ...(opts.additionalFiles ?? [])];
  for (const f of files) {
    py.FS.mkdirTree(dirname(f.path));
    py.FS.writeFile(f.path, f.content);
  }
  py.FS.writeFile(`${WORK_DIR}/input.csv`, csvContent);
  if (opts.geojsonContent) py.FS.writeFile(`${WORK_DIR}/input.geojson`, opts.geojsonContent);

  // Run prelude + code; a Python exception becomes exitCode 1 + stderr.txt, so
  // parseSandboxOutput's error path lights up exactly as it does for Docker.
  let exitCode = 0;
  try {
    await py.runPythonAsync(WASM_PRELUDE + "\n" + code);
  } catch (err) {
    exitCode = 1;
    py.FS.writeFile(`${WORK_DIR}/stderr.txt`, String(err instanceof Error ? err.message : err));
  }

  const readFile = async (path: string): Promise<string | null> => {
    try {
      return py.FS.readFile(path, { encoding: "utf8" }) as string;
    } catch {
      return null; // ENOENT → null, matching the docker readFile contract
    }
  };

  return parseSandboxOutput({
    readFile,
    workDir: WORK_DIR,
    runtime: "wasm",
    exitCode,
    executionMs: Date.now() - start,
  });
}
