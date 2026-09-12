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

  // The geo-run shape (run 9cb7770b): boot requests the vendored spatial
  // extension, then the code runs the exact statements the geo skill stack
  // generates — its own `LOAD spatial` (a no-op against the boot-loaded
  // extension) and ST_* calls through the shim. This is the acceptance gate for
  // the local extension repo serving spatial: before it was vendored, the LOAD
  // died as the anonymous _setThrew crash on the first statement.
  const spatialRequest = {
    type: "wasm-execute",
    id: "e2e-spatial",
    csvContent: "",
    code: [
      "import duckdb, json",
      'duckdb.sql("LOAD spatial")',
      'row = duckdb.sql("""',
      "  SELECT ST_X(ST_Point(11.5, 48.1)) AS x,",
      "         ST_Contains(ST_GeomFromText('POLYGON((0 0,0 2,2 2,2 0,0 0))'), ST_Point(1, 1)) AS inside,",
      "         ST_Distance_Sphere(ST_Point(0, 0), ST_Point(0, 1)) AS meters",
      '""").fetchone()',
      "with open('/data/output.json', 'w') as f:",
      "    json.dump({'x': row[0], 'inside': bool(row[1]), 'meters': row[2]}, f)",
    ].join("\n"),
    files: [],
    duckdb: { base: "/duckdb/", aliases: [], spatial: true },
  };

  // The D9 staged-file bridge: DuckDB reads the inline-staged /data/input.csv
  // by its Docker-identical path (registerFileBuffer under the hood). Before the
  // bridge this failed with "file not found" — the audit's top prompt-facing gap.
  const memfsRequest = {
    type: "wasm-execute",
    id: "e2e-memfs",
    csvContent: "region,revenue\nnorth,100\nsouth,250\neast,175\n",
    code: [
      "import duckdb, json",
      "row = duckdb.sql(\"SELECT COUNT(*) AS n, SUM(revenue) AS total FROM '/data/input.csv'\").fetchone()",
      "with open('/data/output.json', 'w') as f:",
      "    json.dump({'n': row[0], 'total': row[1]}, f)",
    ].join("\n"),
    files: [],
    duckdb: { base: "/duckdb/", aliases: [] },
  };

  // The in-worker pre-flight lint, behaviorally: an undefined name must fail
  // BEFORE execution with the Docker-identical retry message.
  const lintRequest = {
    type: "wasm-execute",
    id: "e2e-lint",
    csvContent: "",
    code: "import json\nresult = undefined_helper(1)\n",
    files: [],
  };

  // The 500k-row materialization cap, behaviorally: an unaggregated large
  // result must fail with the retry-actionable message, not OOM the worker.
  const rowcapRequest = {
    type: "wasm-execute",
    id: "e2e-rowcap",
    csvContent: "",
    code: ["import duckdb", "rows = duckdb.sql('SELECT * FROM range(600000)').fetchall()"].join(
      "\n"
    ),
    files: [],
    duckdb: { base: "/duckdb/", aliases: [] },
  };

  // cxa-capture acceptance: a REAL C++ exception (glob matching no registered
  // files → duckdb::IOException) must surface with the ORIGINAL DuckDB message
  // decoded, not the anonymous "could not report it" crash that burned runs
  // 9cb7770b and 9ee0e56b. This posts straight to the worker, bypassing the
  // sidecar's pre-flight glob guard on purpose — the engine path is the thing
  // under test.
  const cxaRequest = {
    type: "wasm-execute",
    id: "e2e-cxa",
    csvContent: "",
    code: [
      "import duckdb",
      "duckdb.sql(\"SELECT * FROM read_parquet('no/such/prefix-*.parquet')\").fetchall()",
    ].join("\n"),
    files: [],
    duckdb: { base: "/duckdb/", aliases: [] },
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
    if (url === "/spatial-request.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(spatialRequest));
      return;
    }
    if (url === "/memfs-request.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(memfsRequest));
      return;
    }
    if (url === "/lint-request.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(lintRequest));
      return;
    }
    if (url === "/rowcap-request.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rowcapRequest));
      return;
    }
    if (url === "/cxa-request.json") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(cxaRequest));
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

/** The vendored spatial extension, wherever the version-named repo dir landed. */
const spatialVendored = (() => {
  try {
    const extRoot = join(DUCKDB_DIR, "ext");
    return readdirSync(extRoot).some((v) =>
      existsSync(join(extRoot, v, "wasm_mvp", "spatial.duckdb_extension.wasm"))
    );
  } catch {
    return false;
  }
})();

test("the geo-run shape: spatial INSTALL+LOADs from the local repo and ST_* functions execute", async ({
  page,
}) => {
  test.skip(
    !assetsPresent || !spatialVendored,
    "pyodide / duckdb-wasm / spatial assets not present"
  );
  test.setTimeout(300_000); // cold pyodide + duckdb + spatial boot

  await page.goto(base + "/?req=spatial-request");
  await page.waitForFunction(() => (window as { __result?: unknown }).__result !== null, null, {
    timeout: 280_000,
  });
  const result = (await page.evaluate(() => (window as { __result?: unknown }).__result)) as {
    exitCode: number;
    output: unknown;
    stderr?: string;
  };
  // Before spatial was vendored this failed here, with the _setThrew shim's
  // message in stderr (run 9cb7770b) — the assertion names the regression.
  expect(result.stderr ?? "").toBe("");
  expect(result.exitCode).toBe(0);
  const out = (typeof result.output === "string" ? JSON.parse(result.output) : result.output) as {
    x: number;
    inside: boolean;
    meters: number;
  };
  expect(out.x).toBeCloseTo(11.5, 6);
  expect(out.inside).toBe(true);
  // One degree of latitude ≈ 111 km — proves real geodesic math ran, not a stub.
  expect(out.meters).toBeGreaterThan(110_000);
  expect(out.meters).toBeLessThan(112_000);
});

test("setThrew wiring: a real C++ engine exception surfaces as an ORDINARY DuckDB error", async ({
  page,
}) => {
  test.skip(!assetsPresent, "pyodide / duckdb-wasm assets or fixture parquet not present");
  test.setTimeout(300_000);

  await page.goto(base + "/?req=cxa-request");
  await page.waitForFunction(() => (window as { __result?: unknown }).__result !== null, null, {
    timeout: 280_000,
  });
  const result = (await page.evaluate(() => (window as { __result?: unknown }).__result)) as {
    exitCode: number;
    stderr?: string;
  };
  expect(result.exitCode).toBe(1);
  const stderr = result.stderr ?? "";
  // With _setThrew wired to the module's real export, the C++ exception reaches
  // DuckDB's own handlers and comes back as a NORMAL typed query error — the
  // anonymous "internal error" crash (runs 9cb7770b / 9ee0e56b) must be gone.
  expect(stderr, stderr.slice(-600)).toMatch(/IO Error|No files found/);
  expect(stderr).not.toContain("raised an internal error");
  expect(stderr).not.toContain("_setThrew");
});

test("the in-worker pre-flight lint catches an undefined name BEFORE execution (shared checker)", async ({
  page,
}) => {
  test.skip(!assetsPresent, "pyodide / duckdb-wasm assets or fixture parquet not present");
  test.setTimeout(300_000);

  await page.goto(base + "/?req=lint-request");
  await page.waitForFunction(() => (window as { __result?: unknown }).__result !== null, null, {
    timeout: 280_000,
  });
  const result = (await page.evaluate(() => (window as { __result?: unknown }).__result)) as {
    exitCode: number;
    stderr?: string;
  };
  expect(result.exitCode).toBe(1);
  // The Docker-identical retry-facing message, with the offending name.
  expect(result.stderr ?? "").toContain("Undefined name(s)");
  expect(result.stderr ?? "").toContain("`undefined_helper`");
  expect(result.stderr ?? "").toContain("Do NOT change your analysis approach");
});

test("the 500k-row materialization cap fails legibly instead of OOMing the worker", async ({
  page,
}) => {
  test.skip(!assetsPresent, "pyodide / duckdb-wasm assets or fixture parquet not present");
  test.setTimeout(300_000);

  await page.goto(base + "/?req=rowcap-request");
  await page.waitForFunction(() => (window as { __result?: unknown }).__result !== null, null, {
    timeout: 280_000,
  });
  const result = (await page.evaluate(() => (window as { __result?: unknown }).__result)) as {
    exitCode: number;
    stderr?: string;
  };
  expect(result.exitCode).toBe(1);
  expect(result.stderr ?? "").toContain("materialization cap");
  expect(result.stderr ?? "").toContain("Aggregate inside DuckDB");
});

test("DuckDB reads the staged /data/input.csv by its Docker-identical path (D9 bridge)", async ({
  page,
}) => {
  test.skip(!assetsPresent, "pyodide / duckdb-wasm assets or fixture parquet not present");
  test.setTimeout(300_000);

  await page.goto(base + "/?req=memfs-request");
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
    n: number;
    total: number;
  };
  expect(out.n).toBe(3);
  expect(out.total).toBe(525);
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
