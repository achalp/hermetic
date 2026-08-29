/**
 * E2.5 — the live-handoff ACCEPTANCE GATE (spec §4a / build log D6, D8=self).
 *
 * Proves the last hardening step of the WASM live path: the PRODUCTION execution
 * worker (the exact `WASM_WORKER_SOURCE` the /api/wasm-worker route ships) boots
 * Pyodide + numpy/pandas and runs a REAL hermetic_runtime analysis to a correct
 * envelope, INSIDE a worker locked under the production `WASM_EXEC_CSP` (D8=self:
 * `script-src 'self' … ; connect-src 'self'` — same-origin only; in Tauri 'self'
 * is the local app protocol, so no internet egress). The request shape and the
 * `{id, exitCode, output, stderr}` reply are the exact contract the browser client
 * (app/lib/wasm-worker-client) + the sidecar registry drive.
 *
 * Every OTHER piece is already unit-proven: sidecar registry + result route +
 * injection (E2.3), browser controller + hook + CSP header (E2.4), egress isolation
 * under connect-src 'none' (wasm-escape-suite). This gate closes the combination.
 *
 * Assets: node_modules/pyodide (dev deps) + docker/sandbox/hermetic_runtime. No CDN.
 */
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { WASM_EXEC_CSP } from "../src/lib/sandbox/wasm/runtime-constants";
import { WASM_WORKER_SOURCE } from "../src/lib/sandbox/wasm/worker-source";

const ROOT = process.cwd();
const PYODIDE_DIR = join(ROOT, "node_modules", "pyodide");
const RUNTIME_DIR = join(ROOT, "docker", "sandbox", "hermetic_runtime");
const assetsPresent =
  existsSync(join(PYODIDE_DIR, "pyodide.asm.wasm")) &&
  readdirSync(PYODIDE_DIR).some((f) => f.startsWith("numpy") && f.endsWith(".whl"));

// The hermetic_runtime package as the request's `files` (absolute /data paths) —
// exactly what the sidecar prepends before dispatch.
function runtimeFiles(): { path: string; content: string }[] {
  return readdirSync(RUNTIME_DIR)
    .filter((f) => f.endsWith(".py") && !f.startsWith("test_"))
    .map((name) => ({
      path: `/data/hermetic_runtime/${name}`,
      content: readFileSync(join(RUNTIME_DIR, name), "utf8"),
    }));
}

const CSV = "region,revenue\nnorth,190\nsouth,250\neast,175\nwest,380\n";
const ANALYSIS = `
import pandas as pd
from hermetic_runtime.findings import declare_finding
from hermetic_runtime.output import write_output
df = pd.read_csv("/data/input.csv")
# A host-materialized input the worker FETCHED via a same-origin token URL (D11 / B).
remote = pd.read_csv("/data/remote.csv")
total = float(df["revenue"].sum())
top = str(df.sort_values("revenue", ascending=False).iloc[0]["region"])
declare_finding(name="total_revenue", value=total, definition="Sum of revenue.", dtype="number", unit="usd")
write_output(results={"row_count": int(len(df)), "total_revenue": total, "top_region": top, "remote_rows": int(len(remote))})
`;

// The "remote" object, delivered to the worker over the same-origin input endpoint.
const REMOTE_CSV = "id\n10\n20\n30\n";

const CT: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".zip": "application/zip",
  ".whl": "application/octet-stream",
};

let server: Server;
let base: string;

test.beforeAll(async () => {
  const request = {
    type: "wasm-execute",
    id: "e2e-1",
    csvContent: CSV,
    code: ANALYSIS,
    files: runtimeFiles(),
    // Option B: the worker fetches this same-origin URL into /data/remote.csv.
    fetchInputs: [{ path: "/data/remote.csv", url: "/wasm-input/tok" }],
  };
  server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/exec-worker.js") {
      // The PRODUCTION worker source under the PRODUCTION CSP.
      res.writeHead(200, {
        "content-type": "text/javascript",
        "content-security-policy": WASM_EXEC_CSP,
      });
      res.end(WASM_WORKER_SOURCE);
      return;
    }
    if (url === "/wasm-input/tok") {
      // Stands in for /api/wasm-input/<token> (the run-scoped host-file endpoint).
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(REMOTE_CSV);
      return;
    }
    if (url === "/request.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(request));
      return;
    }
    if (url.startsWith("/pyodide/")) {
      const name = url.slice("/pyodide/".length);
      try {
        res.writeHead(200, {
          "content-type": CT[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream",
        });
        res.end(readFileSync(join(PYODIDE_DIR, name)));
      } catch {
        res.writeHead(404).end("nf");
      }
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><meta charset=utf-8><title>live-handoff</title><script>
      window.__result = null;
      (async () => {
        const request = await (await fetch("/request.json")).json();
        const w = new Worker("/exec-worker.js");
        w.onmessage = (e) => { window.__result = e.data; };
        w.onerror = (e) => { window.__result = { error: String(e.message||e) }; };
        w.postMessage({ indexURL: "/pyodide/", request });
      })();
    </script>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

test("the production worker boots + runs a real analysis under WASM_EXEC_CSP (D8=self)", async ({
  page,
}) => {
  test.skip(!assetsPresent, "node_modules/pyodide numpy/pandas wheels not present");
  await page.goto(base);
  await page.waitForFunction(() => (window as unknown as { __result: unknown }).__result !== null, {
    timeout: 120_000,
  });
  const result = await page.evaluate(
    () =>
      (
        window as unknown as {
          __result: { id?: string; exitCode?: number; output?: string; error?: string };
        }
      ).__result
  );

  expect(result.error, `worker error: ${result.error}`).toBeFalsy();
  expect(result.id).toBe("e2e-1");
  expect(result.exitCode).toBe(0);

  // The raw envelope the sidecar would relay + decode: correct pandas result.
  const envelope = JSON.parse(result.output!);
  // remote_rows:3 proves the worker fetched the same-origin input into its FS (D11/B).
  expect(envelope.results).toMatchObject({
    row_count: 4,
    total_revenue: 995,
    top_region: "west",
    remote_rows: 3,
  });
  expect(
    (envelope.findings as { name?: string; value?: unknown }[]).find(
      (f) => f.name === "total_revenue"
    )?.value
  ).toBe(995);
});
