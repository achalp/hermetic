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
  // Entities run CONCURRENTLY in one container, each with its own /data/eN.*
  // slot — keyed by that index so a result can never be attributed to the
  // wrong entity (the correctness risk parallelism introduces).
  run.mockImplementation(async (_bin, args) => {
    const joined = args.join(" ");
    if (args[0] === "run") return { stdout: "", stderr: "", exitCode: 0 };
    if (args[0] === "rm") return { stdout: "", stderr: "", exitCode: 0 };
    const slot = /\/data\/e(\d+)\./.exec(joined)?.[1];
    if (joined.includes("cat > /data/e")) return { stdout: "", stderr: "", exitCode: 0 };
    if (joined.includes("python3 /data/e")) {
      onPythonExec?.();
      const i = Number(slot ?? 0);
      return { stdout: perEntity[i] === "ok" ? "0\n" : "1\n", stderr: "", exitCode: 0 };
    }
    if (joined.includes(".json")) return { stdout: OUTPUT, stderr: "", exitCode: 0 };
    if (joined.includes(".err"))
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

  it("stops taking NEW entities once the BUDGET is spent; the rest are skipped", async () => {
    let now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    // Each python exec "costs" 40s of wall clock. Entities run CONCURRENTLY, so
    // several start before the budget is spent — but once it IS spent, no
    // further entity may start, and every unattempted one is reported skipped
    // (skipped means PENDING to the caller, never failed).
    scriptDocker(Array(8).fill("ok"), () => {
      now += 40_000;
    });
    const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const { results, skipped } = await extractRemoteParquetSchemaBatch(
      names.map(target),
      undefined,
      60_000
    );
    expect(skipped.length).toBeGreaterThan(0); // the budget did bound the work
    // Attempted + skipped accounts for EVERY target, with no overlap.
    expect([...results.keys()].length + skipped.length).toBe(names.length);
    expect([...results.keys()].some((n) => skipped.includes(n))).toBe(false);
  });

  it("runs entities CONCURRENTLY (the serialization was an accident of shared file paths)", async () => {
    let inFlight = 0;
    let peak = 0;
    run.mockImplementation(async (_bin, args) => {
      const joined = args.join(" ");
      if (args[0] === "run" || args[0] === "rm") return { stdout: "", stderr: "", exitCode: 0 };
      if (joined.includes("python3 /data/e")) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return { stdout: "0\n", stderr: "", exitCode: 0 };
      }
      if (joined.includes(".json")) return { stdout: OUTPUT, stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const { results } = await extractRemoteParquetSchemaBatch(
      ["a", "b", "c", "d", "e", "f"].map(target),
      undefined,
      60_000
    );
    expect(results.size).toBe(6);
    expect(peak).toBeGreaterThan(1); // genuinely parallel
  });

  it("each entity reads its OWN slot — a result can never be attributed to another entity", async () => {
    // The correctness risk parallelism introduces: shared /data/output.json
    // would let one entity's schema land under another's name.
    const seen: string[] = [];
    run.mockImplementation(async (_bin, args) => {
      const joined = args.join(" ");
      if (args[0] === "run" || args[0] === "rm") return { stdout: "", stderr: "", exitCode: 0 };
      if (joined.includes("python3 /data/e")) return { stdout: "0\n", stderr: "", exitCode: 0 };
      if (joined.includes(".json")) {
        seen.push(joined.slice(joined.lastIndexOf("/data/e")));
        return { stdout: OUTPUT, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    await extractRemoteParquetSchemaBatch(["a", "b", "c"].map(target), undefined, 60_000);
    // Three DISTINCT slot files were read — never one shared output path.
    expect(new Set(seen).size).toBe(3);
    expect(seen.every((p) => /\/data\/e\d+\.json/.test(p))).toBe(true);
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
  it("emits connect-progress phases: network-up then extracting/extracted per entity", async () => {
    scriptDocker(["ok", "fail"]);
    const events: import("@/lib/manifest/shared").ConnectProgress[] = [];
    await extractRemoteParquetSchemaBatch([target("a"), target("b")], undefined, 60_000, (e) =>
      events.push(e)
    );
    expect(events[0]).toMatchObject({ phase: "network-up" });
    // One extracting + one extracted per entity, in order.
    expect(
      events.filter((e) => e.phase === "extracting").map((e) => (e as { entity: string }).entity)
    ).toEqual(["a", "b"]);
    const extracted = events.filter((e) => e.phase === "extracted") as {
      entity: string;
      ok: boolean;
    }[];
    expect(extracted).toEqual([
      { phase: "extracted", entity: "a", ok: true },
      { phase: "extracted", entity: "b", ok: false },
    ]);
  });
  it("bounds a slow entity to the REMAINING budget so siblings are not starved", async () => {
    // Regression: an entity that failed at ~90s against a 60s budget consumed
    // the whole batch budget, so every sibling was skipped — and the next
    // connect re-attempted the same entity forever.
    scriptDocker(["ok", "ok"]);
    await extractRemoteParquetSchemaBatch([target("a"), target("b")], undefined, 60_000);
    // The per-entity exec timeout is never larger than what's left of the budget.
    const execCalls = run.mock.calls.filter(
      (c) => c[1][0] === "exec" && String(c[1].at(-1)).includes("python3 /data/e")
    );
    expect(execCalls.length).toBeGreaterThan(0);
    for (const call of execCalls) {
      const opts = call[2] as { timeoutMs?: number } | undefined;
      expect(opts?.timeoutMs).toBeLessThanOrEqual(60_000);
      expect(opts?.timeoutMs).toBeGreaterThan(0);
    }
  });
});
