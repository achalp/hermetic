/**
 * Phase 0(b)/1c END-TO-END: the hermetic_runtime runs inside a REAL browser Web
 * Worker (headless chromium) and produces a valid output.json envelope — the
 * browser-side COMPUTE half of the no-Docker analysis path. (The ISOLATION half —
 * that the worker can't exfiltrate under connect-src 'none' — is proven separately
 * by wasm-escape-suite.spec.ts. Combining them under a single strict-CSP blob-load
 * is the last hardening step; this proves execution works in-browser.)
 *
 * The worker boots Pyodide (core only — the analysis uses the PURE-PYTHON runtime,
 * no numpy/pandas wheels), stages the real docker/sandbox/hermetic_runtime into
 * MEMFS, runs an analysis that declare_finding()s + write_output()s, reads
 * /data/output.json back, and posts it out. Everything is served locally (no CDN).
 */
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Playwright runs from the repo root.
const ROOT = process.cwd();
const PYODIDE_DIR = join(ROOT, "node_modules", "pyodide");
const RUNTIME_DIR = join(ROOT, "docker", "sandbox", "hermetic_runtime");

// The pure-Python runtime files (skip tests) as a name→source map the worker
// writes into MEMFS.
function runtimeFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(RUNTIME_DIR)) {
    if (f.endsWith(".py") && !f.startsWith("test_"))
      out[f] = readFileSync(join(RUNTIME_DIR, f), "utf8");
  }
  return out;
}

const ANALYSIS = `
import sys, json
sys.path.insert(0, "/data")
from hermetic_runtime.findings import declare_finding
from hermetic_runtime.output import write_output
declare_finding(
    name="answer",
    value=42,
    definition="A finding declared from inside a real browser Web Worker.",
    dtype="number",
    unit="count",
)
write_output(results={"ran_in_browser": True, "engine": "pyodide-webworker"})
`;

const WORKER_JS = `
self.onmessage = async (e) => {
  const { pyodideBase, runtime, analysis } = e.data;
  try {
    importScripts(pyodideBase + "pyodide.js");
    const pyodide = await self.loadPyodide({ indexURL: pyodideBase });
    pyodide.FS.mkdirTree("/data/hermetic_runtime");
    for (const [name, content] of Object.entries(runtime)) {
      pyodide.FS.writeFile("/data/hermetic_runtime/" + name, content);
    }
    await pyodide.runPythonAsync(analysis);
    const output = pyodide.FS.readFile("/data/output.json", { encoding: "utf8" });
    self.postMessage({ ok: true, output });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message || err) });
  }
};
`;

const CT: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".zip": "application/zip",
  ".ts": "application/octet-stream",
};

let server: Server;
let base: string;

test.beforeAll(async () => {
  const runtime = JSON.stringify(runtimeFiles());
  server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    // The worker's own CSP: allow loading Pyodide's scripts/wasm + same-origin
    // fetches for its assets. (The strict connect-src 'none' exec-CSP is proven
    // in wasm-escape-suite; here we validate execution.)
    if (url === "/exec-worker.js") {
      res.writeHead(200, {
        "content-type": "text/javascript",
        "content-security-policy":
          "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' blob:; connect-src 'self'; worker-src 'none'",
      });
      res.end(WORKER_JS);
      return;
    }
    if (url === "/runtime.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(runtime);
      return;
    }
    if (url.startsWith("/pyodide/")) {
      const name = url.slice("/pyodide/".length);
      try {
        const buf = readFileSync(join(PYODIDE_DIR, name));
        const ext = name.slice(name.lastIndexOf("."));
        res.writeHead(200, { "content-type": CT[ext] ?? "application/octet-stream" });
        res.end(buf);
      } catch {
        res.writeHead(404).end("nf");
      }
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><meta charset=utf-8><title>wasm exec</title><script>
      window.__result = null;
      const w = new Worker("/exec-worker.js");
      w.onmessage = (e) => { window.__result = e.data; };
      w.onerror = (e) => { window.__result = { ok:false, error: String(e.message||e) }; };
      fetch("/runtime.json").then(r=>r.json()).then(runtime => {
        w.postMessage({ pyodideBase: "/pyodide/", runtime, analysis: ${JSON.stringify(ANALYSIS)} });
      });
    </script>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

test("hermetic_runtime runs in a real browser worker and emits a valid envelope", async ({
  page,
}) => {
  await page.goto(base);
  await page.waitForFunction(() => (window as unknown as { __result: unknown }).__result !== null, {
    timeout: 60_000,
  });
  const result = await page.evaluate(
    () =>
      (window as unknown as { __result: { ok: boolean; output?: string; error?: string } }).__result
  );

  expect(result.error, `worker error: ${result.error}`).toBeFalsy();
  expect(result.ok).toBe(true);

  const envelope = JSON.parse(result.output!);
  // The results object write_output emitted, from inside the browser.
  expect(envelope.results).toMatchObject({ ran_in_browser: true, engine: "pyodide-webworker" });
  // The declared finding survived the registry → output.json path in-browser.
  const findings = envelope.findings as { name?: string; value?: number }[];
  const answer = findings.find((f) => f.name === "answer");
  expect(answer, `findings: ${JSON.stringify(findings)}`).toBeDefined();
  expect(answer!.value).toBe(42);
});
