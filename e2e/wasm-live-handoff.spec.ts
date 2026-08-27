/**
 * E2.5 — the live-handoff ACCEPTANCE GATE (spec §4a / build log D6, D8).
 *
 * This encodes the one remaining hardening step for the WASM live path: booting
 * Pyodide + running a real analysis inside a worker locked under the STRICT
 * execution CSP (`connect-src 'none'`, `script-src blob:` with NO 'self') — the
 * exact policy the escape suite proved airtight. Every OTHER piece of the handoff
 * is already validated:
 *   - the sidecar registry + result route + pipeline injection (E2.3 unit tests),
 *   - the browser controller + worker route CSP + hook wiring (E2.4 unit tests),
 *   - Pyodide EXECUTION in a real worker under a LOOSER CSP (wasm-browser-analysis),
 *   - egress ISOLATION under `connect-src 'none'` (wasm-escape-suite).
 *
 * What is unproven — and what this gate exists to prove — is the COMBINATION:
 * Pyodide booting with ZERO network (its `.asm.mjs` via import(), its `.wasm` and
 * `python_stdlib.zip` via fetch, all resolved against a *directory* indexURL) when
 * the CSP forbids same-origin script/connect. Pyodide's public API exposes no clean
 * "here are the bytes" path for these, so a solution needs one of the D8 options
 * (blob-URL asset redirection, a same-origin service-worker host, or the
 * Tauri-local `connect-src 'self'` refinement). Until one lands this is `fixme`:
 * flip it to `test(...)` and iterate the offline blob-delivery below once chosen.
 *
 * Assets: node_modules/pyodide (present as dev deps). No CDN, no network.
 */
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { WASM_EXEC_CSP } from "../src/lib/sandbox/wasm/runtime-constants";

const PYODIDE_DIR = join(process.cwd(), "node_modules", "pyodide");
const assetsPresent = existsSync(join(PYODIDE_DIR, "pyodide.asm.wasm"));

// The worker: boot Pyodide from MAIN-THREAD-delivered blob URLs (no network), run
// a tiny analysis, post the raw envelope. This is the strict-CSP boot attempt.
const WORKER_JS = `
self.onmessage = async (e) => {
  const { pyodideScriptUrl, indexURL, code } = e.data;
  try {
    importScripts(pyodideScriptUrl); // blob: — allowed by script-src blob:
    const pyodide = await self.loadPyodide({ indexURL }); // ← the strict-CSP fetch wall
    const out = await pyodide.runPythonAsync(code);
    self.postMessage({ ok: true, out: String(out) });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};
`;

let server: Server;
let base: string;

test.beforeAll(async () => {
  server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/exec-worker.js") {
      res.writeHead(200, {
        "content-type": "text/javascript",
        "content-security-policy": WASM_EXEC_CSP, // the STRICT boundary CSP
      });
      res.end(WORKER_JS);
      return;
    }
    if (url.startsWith("/pyodide/")) {
      const name = url.slice("/pyodide/".length);
      try {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end(readFileSync(join(PYODIDE_DIR, name)));
      } catch {
        res.writeHead(404).end("nf");
      }
      return;
    }
    // Host page: MAIN thread pre-fetches pyodide.js as a blob, boots the worker.
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><meta charset=utf-8><title>live-handoff</title><script>
      window.__result = null;
      (async () => {
        const js = await (await fetch("/pyodide/pyodide.js")).blob();
        const scriptUrl = URL.createObjectURL(js);
        const w = new Worker("/exec-worker.js");
        w.onmessage = (e) => { window.__result = e.data; };
        w.onerror = (e) => { window.__result = { ok:false, error:String(e.message||e) }; };
        w.postMessage({ pyodideScriptUrl: scriptUrl, indexURL: "/pyodide/", code: "6*7" });
      })();
    </script>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

// FIXME(E2.5 / build log D8): un-fixme once offline Pyodide boot under the strict
// CSP is solved (D8 option chosen). The wiring around it (registry, route, hook,
// controller) is already unit-proven; this is the last hardening step.
test.fixme("Pyodide boots + runs under the strict exec CSP (connect-src 'none')", async ({
  page,
}) => {
  test.skip(!assetsPresent, "node_modules/pyodide assets not present");
  await page.goto(base);
  await page.waitForFunction(
    () => (window as unknown as { __result?: unknown }).__result !== null,
    {
      timeout: 90_000,
    }
  );
  const result = await page.evaluate(
    () => (window as unknown as { __result: { ok: boolean } }).__result
  );
  expect(result.ok, JSON.stringify(result)).toBe(true);
});
