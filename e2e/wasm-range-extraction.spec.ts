/**
 * D36 ACCEPTANCE GATE — the graduated live-repro: DuckDB-in-the-worker extracts a
 * schema over the RANGE PROTOCOL, end to end, with no network.
 *
 * Three live failures shipped behind unit tests that could not see them (HEAD-200
 * in D31; force-full reads + Arrow-toString-is-not-JSON in D36) because nothing
 * exercised the PRODUCTION worker against the range route's contract. This does:
 *
 *  - the exact `WASM_WORKER_SOURCE` the /api/wasm-worker route ships, under the
 *    production `WASM_EXEC_CSP` (which also injects DUCKDB_PY_SHIM + the boot fn
 *    with the D36 filesystem config);
 *  - the same-origin duckdb bundle + mvp wasm + extension repo from
 *    public/duckdb-wasm — the REAL shipped artifacts (incl. the _setThrew shim);
 *  - the D27 script builder's actual output (`buildWasmRemoteSchemaScript`);
 *  - a fixture parquet (built by e2e-build-fixture.mts) carrying the exact shapes
 *    that broke live: quoted strings, BIGINT, DECIMAL, DATE, zero-padded codes;
 *  - a fixture server whose GET path accepts/rejects ranges through the RANGE
 *    ROUTE'S OWN exported `parseRange` — the contract itself, not a mock's
 *    opinion of it (the D31 lesson), and whose HEAD answers the D31 206 shape.
 *
 * The assertions pin each regression by its failure mode: a rangeless GET or any
 * 416 means the filesystem config regressed (D36-1); a JSON profile with the
 * quoted label intact means the serializer holds (D36-3); leading zeros surviving
 * as strings is the housing dataset's own requirement.
 */
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { WASM_EXEC_CSP } from "../src/lib/sandbox/wasm/runtime-constants";
import { WASM_WORKER_SOURCE } from "../src/lib/sandbox/wasm/worker-source";
import { buildWasmRemoteSchemaScript } from "../src/lib/parquet/schema-script";
import { parseRange } from "../src/app/api/wasm-range/[token]/route";

const ROOT = process.cwd();
const PYODIDE_DIR = join(ROOT, "node_modules", "pyodide");
const DUCKDB_DIR = join(ROOT, "public", "duckdb-wasm");
const FIXTURE = join(ROOT, "e2e", ".artifacts", "entities.parquet");
const FIXTURE2 = join(ROOT, "e2e", ".artifacts", "lookup.parquet");

const assetsPresent =
  existsSync(join(PYODIDE_DIR, "pyodide.asm.wasm")) &&
  readdirSync(PYODIDE_DIR).some((f) => f.startsWith("numpy") && f.endsWith(".whl")) &&
  existsSync(join(DUCKDB_DIR, "duckdb-bundle.js")) &&
  existsSync(join(DUCKDB_DIR, "duckdb-mvp.wasm")) &&
  existsSync(FIXTURE) &&
  existsSync(FIXTURE2);

const CT: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".zip": "application/zip",
  ".whl": "application/octet-stream",
};

function serveDir(dir: string, name: string, res: import("node:http").ServerResponse) {
  try {
    res.writeHead(200, {
      "content-type": CT[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream",
    });
    res.end(readFileSync(join(dir, name)));
  } catch {
    res.writeHead(404).end("nf");
  }
}

let server: Server;
let base: string;
/** Every request the worker made to the range endpoint — the protocol ledger. */
const rangeLedger: { method: string; range: string | null; status: number }[] = [];

test.beforeAll(async () => {
  const fixture = readFileSync(FIXTURE);
  const fixture2 = readFileSync(FIXTURE2);
  const byToken: Record<string, Buffer> = { tok: fixture, tok2: fixture2 };
  const ALIAS = "entities.parquet";
  const request = {
    type: "wasm-execute",
    id: "e2e-d36",
    csvContent: "",
    code: buildWasmRemoteSchemaScript([ALIAS], false),
    files: [],
    duckdb: { base: "/duckdb/", aliases: [{ name: ALIAS, url: "/api/wasm-range/tok" }] },
  };
  // D40: the manifest-question shape — TWO ranged aliases, python JOINs them via
  // the duckdb shim and writes results through the runtime contract.
  const joinRequest = {
    type: "wasm-execute",
    id: "e2e-d40",
    csvContent: "",
    code: [
      "import duckdb, json",
      'rows = duckdb.sql("""',
      "  SELECT l.region, COUNT(*) AS n, SUM(e.big_id) AS total",
      "  FROM read_parquet('entities.parquet') e",
      "  JOIN read_parquet('lookup.parquet') l USING (fips_like)",
      "  GROUP BY l.region ORDER BY l.region",
      '""").fetchall()',
      "with open('/data/output.json', 'w') as f:",
      "    json.dump({'regions': len(rows), 'total': sum(r[2] for r in rows)}, f)",
    ].join("\n"),
    files: [],
    duckdb: {
      base: "/duckdb/",
      aliases: [
        { name: "entities.parquet", url: "/api/wasm-range/tok" },
        { name: "lookup.parquet", url: "/api/wasm-range/tok2" },
      ],
    },
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
    if (url === "/request.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(request));
      return;
    }
    if (url === "/join-request.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(joinRequest));
      return;
    }
    if (url.startsWith("/pyodide/"))
      return serveDir(PYODIDE_DIR, url.slice("/pyodide/".length), res);
    if (url.startsWith("/duckdb/")) return serveDir(DUCKDB_DIR, url.slice("/duckdb/".length), res);

    if (url.startsWith("/api/wasm-range/")) {
      const fixtureBody = byToken[url.slice("/api/wasm-range/".length)];
      if (!fixtureBody) {
        res.writeHead(404).end("nf");
        return;
      }
      // The range contract, through the route's OWN parser. HEAD answers the
      // D31 shape: 206 + Content-Range when the probe carries a Range, else 200.
      const raw = req.headers["range"] ?? null;
      const parsed = parseRange(typeof raw === "string" ? raw : null);
      const total = fixtureBody.length;
      if (req.method === "HEAD") {
        if (!parsed) {
          rangeLedger.push({ method: "HEAD", range: raw as string | null, status: 200 });
          res.writeHead(200, { "content-length": String(total), "accept-ranges": "bytes" });
          res.end();
          return;
        }
        const end = parsed.end === undefined ? total - 1 : Math.min(parsed.end, total - 1);
        rangeLedger.push({ method: "HEAD", range: raw as string | null, status: 206 });
        res.writeHead(206, {
          "content-length": String(total),
          "accept-ranges": "bytes",
          "content-range": `bytes ${parsed.start}-${end}/${total}`,
        });
        res.end();
        return;
      }
      if (!parsed) {
        rangeLedger.push({ method: "GET", range: raw as string | null, status: 416 });
        res.writeHead(416, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "a Range header is required" }));
        return;
      }
      const end = parsed.end === undefined ? total - 1 : Math.min(parsed.end, total - 1);
      const body = fixtureBody.subarray(parsed.start, end + 1);
      rangeLedger.push({ method: "GET", range: raw as string | null, status: 206 });
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
    res.end(`<!doctype html><meta charset=utf-8><title>range-extraction</title><script>
      window.__result = null;
      (async () => {
        const which = new URLSearchParams(location.search).get("req") || "request";
        const request = await (await fetch("/" + which + ".json")).json();
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

test("TWO ranged aliases JOIN in the production worker — the manifest-question shape (D40)", async ({
  page,
}) => {
  test.skip(!assetsPresent, "pyodide / duckdb-wasm assets or fixture parquet not present");
  test.setTimeout(300_000);

  await page.goto(base + "/?req=join-request");
  await page.waitForFunction(() => (window as { __result?: unknown }).__result !== null, null, {
    timeout: 280_000,
  });
  const result = (await page.evaluate(() => (window as { __result?: unknown }).__result)) as {
    exitCode: number;
    output: unknown;
    stderr?: string;
  };
  expect(result.stderr ?? "").toBe("");
  expect(result.exitCode).toBe(0);
  const out = (typeof result.output === "string" ? JSON.parse(result.output) : result.output) as {
    regions: number;
    total: number;
  };
  // 1000 entities keyed 0..99 (i % 100 → fips_like) joined to 100 lookups across
  // 7 regions: every entity row matches exactly one lookup row.
  expect(out.regions).toBe(7);
  expect(out.total).toBeGreaterThan(0);
  // Both fixtures were read by RANGES — and nothing was refused.
  const refused = rangeLedger.filter((e) => e.status === 416);
  expect(refused).toEqual([]);
});

test("DuckDB in the production worker extracts a schema over ranged reads (D36 gate)", async ({
  page,
}) => {
  test.skip(!assetsPresent, "pyodide / duckdb-wasm assets or fixture parquet not present");
  test.setTimeout(300_000); // cold pyodide + duckdb boot

  await page.goto(base);
  await page.waitForFunction(() => (window as { __result?: unknown }).__result !== null, null, {
    timeout: 280_000,
  });
  const result = (await page.evaluate(() => (window as { __result?: unknown }).__result)) as {
    exitCode: number;
    output: unknown;
    stderr?: string;
  };

  // The run itself succeeded — any DuckDB/range failure lands in stderr.
  expect(result.stderr ?? "").toBe("");
  expect(result.exitCode).toBe(0);

  const profile = (
    typeof result.output === "string" ? JSON.parse(result.output) : result.output
  ) as {
    row_count: number;
    columns: { name: string; dtype: string }[];
    sample_rows: Record<string, unknown>[];
  };
  expect(profile.row_count).toBe(1000);
  const dtypes = Object.fromEntries(profile.columns.map((c) => [c.name, c.dtype]));
  // BIGINT/DECIMAL profile as numbers (the D36 serializer's normalize/scale path).
  expect(dtypes.big_id).toBe("number");
  expect(dtypes.ratio).toBe("number");
  expect(dtypes.day).toBe("date");
  // Zero-padded codes stay STRINGS — the housing dataset's own requirement.
  expect(dtypes.fips_like).toBe("string");
  expect(String(profile.sample_rows[0]!.fips_like)).toMatch(/^0\d{4}$|^\d{5}$/);
  // The quoted label survived Arrow → JSON → Python intact (D36-3: Arrow's
  // toString() was NOT JSON precisely because of values like this one).
  expect(String(profile.sample_rows[0]!.quoted_label)).toContain('label "');

  // Protocol ledger (D36-1): with the boot filesystem config in place the worker
  // NEVER sends a rangeless GET, and nothing is refused. A 416 here means the
  // config regressed and DuckDB fell back to whole-object reads.
  const rangelessGets = rangeLedger.filter((e) => e.method === "GET" && !e.range);
  const refused = rangeLedger.filter((e) => e.status === 416);
  expect(rangelessGets).toEqual([]);
  expect(refused).toEqual([]);
  // And it actually READ by ranges — several partial GETs, none the whole object.
  const rangedGets = rangeLedger.filter((e) => e.method === "GET" && e.range);
  expect(rangedGets.length).toBeGreaterThan(2);
});
