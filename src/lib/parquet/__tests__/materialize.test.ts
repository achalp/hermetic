import { describe, it, expect, vi, beforeEach } from "vitest";

const runMock = vi.fn();
vi.mock("@/lib/sandbox/docker-utils", () => ({
  run: (...args: unknown[]) => runMock(...args),
}));
// Keep the prelude + schema-script as real string builders (no Docker needed).

import { materializeCsvToParquet } from "@/lib/parquet/materialize";

const SCHEMA_JSON = JSON.stringify({
  row_count: 1_500_000,
  columns: [{ name: "a", dtype: "int", null_count: 0, meta: { kind: "number" } }],
  sample_rows: [],
  correlations: [],
  detected_domain: "general",
});

// Route each docker call to a sensible fake based on its args.
function wireHappyPath() {
  runMock.mockReset();
  runMock.mockImplementation((_cmd: string, args: string[]) => {
    if (args.includes("python3 /data/script.py > /data/stdout.txt 2>/data/stderr.txt; echo $?")) {
      return Promise.resolve({ stdout: "0\n", stderr: "", exitCode: 0 });
    }
    if (args[0] === "exec" && args.includes("/data/output.json")) {
      return Promise.resolve({ stdout: SCHEMA_JSON, stderr: "", exitCode: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  });
}

beforeEach(wireHappyPath);

describe("materializeCsvToParquet", () => {
  it("rejects non-docker runtimes", async () => {
    await expect(
      materializeCsvToParquet("a\n1", "id1", "f.csv", "microsandbox" as never)
    ).rejects.toThrow(/Docker/);
  });

  it("converts, copies the parquet out, and returns the DuckDB-extracted schema", async () => {
    const { parquetPath, schema } = await materializeCsvToParquet("a\n1", "id1", "f.csv", "docker");

    expect(parquetPath).toMatch(/id1\.parquet$/);
    expect(schema.row_count).toBe(1_500_000); // came from DuckDB, not Node parsing
    expect(schema.columns).toHaveLength(1);

    const calls = runMock.mock.calls.map((c) => c[1] as string[]);
    // CSV written to the container
    expect(calls.some((a) => a.join(" ").includes("cat > /data/input.csv"))).toBe(true);
    // Parquet copied OUT to a host path ending in id1.parquet
    const cp = calls.find((a) => a[0] === "cp");
    expect(cp?.[2]).toMatch(/id1\.parquet$/);
    // Container always torn down
    expect(calls.some((a) => a[0] === "rm" && a.includes("-f"))).toBe(true);
  });

  it("surfaces the sandbox stderr on a non-zero exit and still tears down", async () => {
    runMock.mockReset();
    runMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes("python3 /data/script.py > /data/stdout.txt 2>/data/stderr.txt; echo $?")) {
        return Promise.resolve({ stdout: "1\n", stderr: "", exitCode: 0 });
      }
      if (args[0] === "exec" && args.includes("/data/stderr.txt")) {
        return Promise.resolve({ stdout: "duckdb: parse error", stderr: "", exitCode: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    });

    await expect(materializeCsvToParquet("bad", "id2", "f.csv", "docker")).rejects.toThrow(
      /parse error/
    );
    const calls = runMock.mock.calls.map((c) => c[1] as string[]);
    expect(calls.some((a) => a[0] === "rm" && a.includes("-f"))).toBe(true);
  });
});
