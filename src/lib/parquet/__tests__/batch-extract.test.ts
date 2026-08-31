import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The manifest batch extractor (spec §5.5): one container, N entities, one
 * wall-clock budget. Docker is mocked at the `run` seam, so these pin the
 * ORCHESTRATION: budget checked before each entity, per-entity failures never
 * stopping the loop, skipped names reported, and the container removed even
 * when everything blows up.
 */

const run = vi.fn<(bin: string, args: string[], opts?: unknown) => Promise<unknown>>();
vi.mock("@/lib/sandbox/docker-utils", () => ({
  run: (bin: string, args: string[], opts?: unknown) => run(bin, args, opts),
}));

const teardown = vi.fn(async () => {});
const setupEgress = vi.fn(async (_id: string, _hosts: string[]) => ({
  networkName: "net-x",
  env: {},
  proxyLogs: async () => "",
  teardown,
}));
vi.mock("@/lib/sandbox/egress", () => ({
  // Derive per-URL like the real thing (host of the URL), so the union
  // behavior is observable.
  egressPolicyFor: (url: string) => ({ mode: "allowlist", hosts: [new URL(url).host] }),
  setupEgressNetwork: (id: string, hosts: string[]) => setupEgress(id, hosts),
}));

import { extractRemoteParquetSchemaBatch } from "@/lib/parquet/schema-extractor";

const OUTPUT = JSON.stringify({
  row_count: 5,
  columns: [{ name: "x", dtype: "number", null_count: 0, meta: { kind: "number" } }],
  sample_rows: [{ x: 1 }],
  correlations: null,
  detected_domain: "general",
});

/** Script a docker-run dispatcher: per-entity python exec behavior in order. */
function scriptDocker(perEntity: ("ok" | "fail")[], onPythonExec?: () => void) {
  let entity = -1;
  run.mockImplementation(async (_bin, args) => {
    const joined = args.join(" ");
    if (args[0] === "run") return { stdout: "", stderr: "", exitCode: 0 };
    if (args[0] === "rm") return { stdout: "", stderr: "", exitCode: 0 };
    if (joined.includes("cat > /data/script.py")) return { stdout: "", stderr: "", exitCode: 0 };
    if (joined.includes("python3 /data/script.py")) {
      entity++;
      onPythonExec?.();
      return { stdout: perEntity[entity] === "ok" ? "0\n" : "1\n", stderr: "", exitCode: 0 };
    }
    if (joined.includes("cat /data/output.json"))
      return { stdout: OUTPUT, stderr: "", exitCode: 0 };
    if (joined.includes("cat /data/stderr.txt"))
      return { stdout: "duckdb.Error: HTTP 404", stderr: "", exitCode: 0 };
    return { stdout: "", stderr: "", exitCode: 0 };
  });
}

const target = (name: string) => ({
  name,
  readUrl: `https://acct.blob.core.windows.net/data/${name}.parquet`,
  isHivePartitioned: false,
});

beforeEach(() => {
  run.mockReset();
  teardown.mockClear();
  setupEgress.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe("extractRemoteParquetSchemaBatch", () => {
  it("extracts every entity in ONE container and maps schemas out", async () => {
    scriptDocker(["ok", "ok"]);
    const { results, skipped } = await extractRemoteParquetSchemaBatch(
      [target("a"), target("b")],
      undefined,
      60_000
    );
    expect(skipped).toEqual([]);
    expect(results.size).toBe(2);
    const a = results.get("a")!;
    expect("schema" in a && a.schema.row_count).toBe(5);
    // Exactly ONE `docker run` — the whole point of the batch.
    expect(run.mock.calls.filter((c) => c[1][0] === "run")).toHaveLength(1);
    // ...and it is removed at the end.
    expect(run.mock.calls.filter((c) => c[1][0] === "rm")).toHaveLength(1);
  });

  it("a failing entity is recorded and the loop CONTINUES", async () => {
    scriptDocker(["fail", "ok"]);
    const { results } = await extractRemoteParquetSchemaBatch(
      [target("bad"), target("good")],
      undefined,
      60_000
    );
    const bad = results.get("bad")!;
    expect("error" in bad).toBe(true);
    const good = results.get("good")!;
    expect("schema" in good).toBe(true);
  });

  it("stops taking entities once the BUDGET is spent; the rest are skipped", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    // Each python exec "costs" 40s of wall clock — the second entity must not start.
    scriptDocker(["ok", "ok", "ok"], () => {
      now += 40_000;
    });
    const { results, skipped } = await extractRemoteParquetSchemaBatch(
      [target("a"), target("b"), target("c")],
      undefined,
      60_000
    );
    expect([...results.keys()]).toEqual(["a", "b"]); // b started at 40s < 60s
    expect(skipped).toEqual(["c"]); // c would start at 80s ≥ 60s
  });

  it("returns immediately for an empty target list without touching docker", async () => {
    const { results, skipped } = await extractRemoteParquetSchemaBatch([], undefined, 60_000);
    expect(results.size).toBe(0);
    expect(skipped).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("removes the container and tears the network down even when create THROWS", async () => {
    run.mockImplementation(async (_bin, args) => {
      if (args[0] === "run") throw new Error("docker daemon down");
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    await expect(extractRemoteParquetSchemaBatch([target("a")], undefined, 60_000)).rejects.toThrow(
      /daemon down/
    );
    expect(run.mock.calls.filter((c) => c[1][0] === "rm")).toHaveLength(1);
    expect(teardown).toHaveBeenCalled();
  });

  it("multi-host targets get the UNION as the egress allowlist (2026-08-31 policy)", async () => {
    scriptDocker(["ok", "ok"]);
    const { results } = await extractRemoteParquetSchemaBatch(
      [
        target("housing"),
        {
          name: "mirror",
          readUrl: "https://overturemaps-us-west-2.s3.us-west-2.amazonaws.com/x.parquet",
          isHivePartitioned: false,
        },
      ],
      undefined,
      60_000
    );
    expect(results.size).toBe(2);
    expect(setupEgress).toHaveBeenCalledTimes(1);
    const hosts = setupEgress.mock.calls[0]![1] as unknown as string[];
    expect([...hosts].sort()).toEqual([
      "acct.blob.core.windows.net",
      "overturemaps-us-west-2.s3.us-west-2.amazonaws.com",
    ]);
  });
});
