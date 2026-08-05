/**
 * Egress-allowlist proof (lib/sandbox/egress.ts) — real containers, real
 * internal network, real proxy. Run: npx tsx scripts/egress-proof.ts
 *
 * A local HTTP server plays the "bucket". Three assertions:
 *   1. ALLOWED : python urllib AND DuckDB read the origin through the
 *                gateway (urllib via proxy env; DuckDB via the prelude's
 *                connect patch — the exact mechanisms remote analyses use).
 *   2. BLOCKED : the same fetch with the origin NOT on the allowlist fails
 *                (proxy 403), proving deny-by-default.
 *   3. NO ROUTE: a direct fetch bypassing the proxy fails, proving the
 *                internal network really has no way out.
 */
import { createServer } from "node:http";
import { installEnvConfig } from "@/harness/env-config";

installEnvConfig("snapshot");

const PORT = 18923;
const ORIGIN_HOST = "host.docker.internal";

function fail(msg: string): never {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { executeSandbox } = await import("@/lib/sandbox");

  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/csv" });
    res.end("k,v\nalpha,1\nbeta,2\n");
  });
  await new Promise<void>((r) => server.listen(PORT, "0.0.0.0", r));

  const fetchCode = `
results = {}
chart_data = {}
import os, urllib.request, duckdb
url = "http://${ORIGIN_HOST}:${PORT}/data.csv"
body = urllib.request.urlopen(url, timeout=20).read().decode()
results["urllib_bytes"] = len(body)
rows = duckdb.connect().execute("SELECT count(*) FROM read_csv('" + url + "')").fetchone()[0]
results["duckdb_rows"] = int(rows)
write_output(results, chart_data)
`;

  try {
    // 1. Allowed
    const allowed = await executeSandbox("a\n1\n", fetchCode, {
      runtime: "docker",
      allowedEgressHosts: [ORIGIN_HOST],
    });
    if (!allowed.success) fail(`allowed run failed: ${(allowed as { error: string }).error}`);
    const r = allowed.results as { urllib_bytes: number; duckdb_rows: number };
    if (r.urllib_bytes < 10) fail("urllib fetch through proxy returned nothing");
    if (r.duckdb_rows !== 2) fail(`duckdb through proxy read ${r.duckdb_rows} rows, wanted 2`);
    console.error(
      `✔ allowed origin readable: urllib ${r.urllib_bytes}B, duckdb ${r.duckdb_rows} rows`
    );

    // 2. Blocked by allowlist
    const blocked = await executeSandbox("a\n1\n", fetchCode, {
      runtime: "docker",
      allowedEgressHosts: ["some.other.host.example"],
    });
    if (blocked.success) fail("fetch to non-allowlisted origin SUCCEEDED — allowlist not enforced");
    console.error("✔ non-allowlisted origin blocked by proxy");

    // 3. No route without the proxy (internal network truly sealed)
    const direct = await executeSandbox(
      "a\n1\n",
      `
results = {}
chart_data = {}
import os, urllib.request
for k in ("HTTP_PROXY","HTTPS_PROXY","http_proxy","https_proxy"):
    os.environ.pop(k, None)
body = urllib.request.urlopen("http://${ORIGIN_HOST}:${PORT}/data.csv", timeout=10).read()
results["direct"] = len(body)
write_output(results, chart_data)
`,
      { runtime: "docker", allowedEgressHosts: [ORIGIN_HOST] }
    );
    if (direct.success)
      fail("direct (proxy-bypassing) fetch SUCCEEDED — internal net has a route out");
    console.error("✔ proxy bypass impossible — internal network has no route");
  } finally {
    server.close();
  }

  console.error("Egress proof ok.");
  process.exit(0);
}

main().catch((err) => {
  console.error("egress-proof:", err instanceof Error ? err.message : err);
  process.exit(1);
});
