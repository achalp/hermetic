/**
 * DIAGNOSTIC (not CI) — repro hunt for the wasm `stoi: no conversion` blocker
 * (handoff finding #1, run 3885e46a). Drives the PRODUCTION worker source over
 * the real range contract against a REAL Overture GeoParquet part file, in four
 * variants: {hive on/off} x {spatial on/off}. Logs outcomes; asserts nothing
 * beyond "the worker answered", because the point is evidence, not a gate.
 *
 * Requires e2e/.artifacts/overture-real.parquet (a genuine Overture part file,
 * downloaded ad hoc — NOT committed). Skips when absent.
 */
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { WASM_EXEC_CSP } from "../src/lib/sandbox/wasm/runtime-constants";
import { WASM_WORKER_SOURCE } from "../src/lib/sandbox/wasm/worker-source";
import { parseRange } from "../src/app/api/wasm-range/[token]/route";

const ROOT = process.cwd();
const PYODIDE_DIR = join(ROOT, "node_modules", "pyodide");
const DUCKDB_DIR = join(ROOT, "public", "duckdb-wasm");
const REAL_FILE = join(ROOT, "e2e", ".artifacts", "overture-real.parquet");

// The alias mirrors the field shape: the verbatim object key, key=value segments.
const ALIAS =
  "release/2026-08-19.0/theme=base/type=bathymetry/part-00000-cf17cfee-00e5-5871-9cab-7f48d910d28f-c000.zstd.parquet";

const assetsPresent =
  existsSync(join(PYODIDE_DIR, "pyodide.asm.wasm")) &&
  existsSync(join(DUCKDB_DIR, "duckdb-bundle.js")) &&
  existsSync(join(DUCKDB_DIR, "duckdb-mvp.wasm")) &&
  existsSync(REAL_FILE);

const spatialVendored = (() => {
  try {
    return readdirSync(join(DUCKDB_DIR, "ext")).some((v) =>
      existsSync(join(DUCKDB_DIR, "ext", v, "wasm_mvp", "spatial.duckdb_extension.wasm"))
    );
  } catch {
    return false;
  }
})();

const CT: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".zip": "application/zip",
  ".whl": "application/octet-stream",
};

function probeCode(hive: boolean, spatial: boolean): string {
  const readExpr = `read_parquet(['${ALIAS}']${hive ? ", hive_partitioning=true" : ""})`;
  return [
    "import duckdb, json",
    "steps = {}",
    "def step(name, sql):",
    "    try:",
    "        steps[name] = str(duckdb.sql(sql).fetchall())[:200]",
    "    except Exception as e:",
    "        steps[name] = 'ERR: ' + str(e)[:400]",
    ...(spatial ? ["step('load_spatial', 'LOAD spatial')"] : []),
    `step('version', 'SELECT version()')`,
    `step('count', "SELECT COUNT(*) FROM ${readExpr}")`,
    `step('view', "CREATE OR REPLACE VIEW data AS SELECT * FROM ${readExpr}")`,
    `step('schema', "DESCRIBE data")`,
    `step('sample', "SELECT id, depth FROM data LIMIT 2")`,
    ...(spatial ? [`step('geom', "SELECT ST_GeometryType(geometry) g FROM data LIMIT 1")`] : []),
    "with open('/data/output.json', 'w') as f:",
    "    json.dump(steps, f)",
  ].join("\n");
}

let server: Server;
let base: string;

test.beforeAll(async () => {
  const fixture = assetsPresent ? readFileSync(REAL_FILE) : Buffer.alloc(0);

  const variants: Record<string, { hive: boolean; spatial: boolean }> = {
    plain: { hive: false, spatial: false },
    hive: { hive: true, spatial: false },
    spatial: { hive: false, spatial: true },
    "hive-spatial": { hive: true, spatial: true },
  };

  server = createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/exec-worker.js") {
      res.writeHead(200, {
        "content-type": "text/javascript",
        "content-security-policy": WASM_EXEC_CSP,
      });
      res.end(WASM_WORKER_SOURCE);
      return;
    }
    const m = /^\/req-([a-z-]+)\.json$/.exec(url);
    if (m && variants[m[1]]) {
      const v = variants[m[1]];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "wasm-execute",
          id: `stoi-${m[1]}`,
          csvContent: "",
          code: probeCode(v.hive, v.spatial),
          files: [],
          duckdb: {
            base: "/duckdb/",
            aliases: [{ name: ALIAS, url: "/api/wasm-range/tok" }],
            spatial: v.spatial,
          },
        })
      );
      return;
    }
    if (url.startsWith("/pyodide/") || url.startsWith("/duckdb/")) {
      const dir = url.startsWith("/pyodide/") ? PYODIDE_DIR : DUCKDB_DIR;
      const name = url.slice(url.indexOf("/", 1) + 1);
      try {
        res.writeHead(200, {
          "content-type": CT[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream",
        });
        res.end(readFileSync(join(dir, name)));
      } catch {
        res.writeHead(404).end("nf");
      }
      return;
    }
    if (url.startsWith("/api/wasm-range/")) {
      const raw = req.headers["range"] ?? null;
      const parsed = parseRange(typeof raw === "string" ? raw : null);
      const total = fixture.length;
      if (req.method === "HEAD") {
        if (!parsed) {
          res.writeHead(200, { "content-length": String(total), "accept-ranges": "bytes" });
          res.end();
          return;
        }
        const end = parsed.end === undefined ? total - 1 : Math.min(parsed.end, total - 1);
        res.writeHead(206, {
          "content-length": String(total),
          "accept-ranges": "bytes",
          "content-range": `bytes ${parsed.start}-${end}/${total}`,
        });
        res.end();
        return;
      }
      if (!parsed) {
        res.writeHead(416, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "a Range header is required" }));
        return;
      }
      const end = parsed.end === undefined ? total - 1 : Math.min(parsed.end, total - 1);
      const body = fixture.subarray(parsed.start, end + 1);
      res.writeHead(206, {
        "content-type": "application/octet-stream",
        "content-length": String(body.length),
        "content-range": `bytes ${parsed.start}-${end}/${total}`,
        "accept-ranges": "bytes",
      });
      res.end(body);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><meta charset=utf-8><title>stoi-repro</title><script>
      window.__result = null;
      (async () => {
        const which = new URLSearchParams(location.search).get("req") || "plain";
        const request = await (await fetch("/req-" + which + ".json")).json();
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

for (const variant of ["plain", "hive", "spatial", "hive-spatial"]) {
  test(`stoi repro probe: ${variant}`, async ({ page }) => {
    test.skip(!assetsPresent, "assets or real Overture fixture not present");
    test.skip(variant.includes("spatial") && !spatialVendored, "spatial not vendored");
    test.setTimeout(300_000);

    await page.goto(`${base}/?req=${variant}`);
    await page.waitForFunction(() => (window as { __result?: unknown }).__result !== null, null, {
      timeout: 280_000,
    });
    const result = (await page.evaluate(() => (window as { __result?: unknown }).__result)) as {
      exitCode?: number;
      output?: unknown;
      stderr?: string;
      error?: string;
    };
    console.log(`=== ${variant} exitCode=${result.exitCode}`);
    console.log(`output: ${JSON.stringify(result.output)}`);
    if (result.stderr) console.log(`stderr: ${result.stderr.slice(-1500)}`);
    if (result.error) console.log(`worker error: ${result.error}`);
    expect(result).not.toBeNull();
  });
}
