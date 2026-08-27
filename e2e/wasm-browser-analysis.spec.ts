/**
 * The FULL no-Docker analysis, end-to-end in headless chromium: a real PANDAS
 * analysis (read_csv → groupby → declare_finding → write_output) runs in a
 * browser Web Worker, loading numpy/pandas from LOCALLY-served wheels (no CDN),
 * and produces the exact envelope the product renders. This is the real product
 * workload proven on the no-Docker path — the upgrade from wasm-browser-exec's
 * pure-Python runtime to the actual pandas compute a generated analysis uses.
 */
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PYODIDE_DIR = join(ROOT, "node_modules", "pyodide");
const RUNTIME_DIR = join(ROOT, "docker", "sandbox", "hermetic_runtime");

function runtimeFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(RUNTIME_DIR)) {
    if (f.endsWith(".py") && !f.startsWith("test_"))
      out[f] = readFileSync(join(RUNTIME_DIR, f), "utf8");
  }
  return out;
}

const CSV = "region,revenue\nnorth,100\nsouth,250\neast,175\nwest,320\nnorth,90\nwest,60\n";

const ANALYSIS = `
import pandas as pd
from hermetic_runtime.findings import declare_finding
from hermetic_runtime.output import write_output

df = pd.read_csv("/data/input.csv")
by_region = df.groupby("region")["revenue"].sum().sort_values(ascending=False)
total = float(df["revenue"].sum())
top = str(by_region.index[0])

declare_finding(name="total_revenue", value=total, definition="Sum of revenue.", dtype="number", unit="usd")
declare_finding(name="top_region", value=top, definition="Highest-revenue region.", dtype="string")
write_output(results={"row_count": int(len(df)), "total_revenue": total, "top_region": top})
`;

const WORKER_JS = `
self.onmessage = async (e) => {
  const { pyodideBase, runtime, analysis } = e.data;
  try {
    importScripts(pyodideBase + "pyodide.js");
    const pyodide = await self.loadPyodide({ indexURL: pyodideBase });
    // Load numpy/pandas from the LOCALLY-served wheels (indexURL), no CDN.
    await pyodide.loadPackage(["numpy", "pandas"]);
    pyodide.FS.mkdirTree("/data/hermetic_runtime");
    for (const [name, content] of Object.entries(runtime)) {
      pyodide.FS.writeFile("/data/hermetic_runtime/" + name, content);
    }
    pyodide.FS.writeFile("/data/input.csv", ${JSON.stringify(CSV)});
    pyodide.runPython('import sys; sys.path.insert(0, "/data")');
    await pyodide.runPythonAsync(analysis);
    const output = pyodide.FS.readFile("/data/output.json", { encoding: "utf8" });
    self.postMessage({ ok: true, output });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.message) || err) });
  }
};
`;

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
  const runtime = JSON.stringify(runtimeFiles());
  server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
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
        res.writeHead(200, {
          "content-type": CT[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream",
        });
        res.end(buf);
      } catch {
        res.writeHead(404).end("nf");
      }
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><meta charset=utf-8><title>analysis</title><script>
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

test("a real pandas analysis runs in-browser (no Docker, local wheels) → correct envelope", async ({
  page,
}) => {
  await page.goto(base);
  await page.waitForFunction(() => (window as unknown as { __result: unknown }).__result !== null, {
    timeout: 90_000,
  });
  const result = await page.evaluate(
    () =>
      (window as unknown as { __result: { ok: boolean; output?: string; error?: string } }).__result
  );

  expect(result.error, `worker error: ${result.error}`).toBeFalsy();
  expect(result.ok).toBe(true);

  const envelope = JSON.parse(result.output!);
  // The pandas computation is correct: north 190, south 250, east 175, west 380.
  expect(envelope.results).toMatchObject({ row_count: 6, total_revenue: 995, top_region: "west" });

  const findings = envelope.findings as { name?: string; value?: unknown }[];
  expect(findings.find((f) => f.name === "total_revenue")?.value).toBe(995);
  expect(findings.find((f) => f.name === "top_region")?.value).toBe("west");
});
