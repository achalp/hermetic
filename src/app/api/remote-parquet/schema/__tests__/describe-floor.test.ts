/**
 * /api/remote-parquet/schema: a failed PROFILE must not lose the table.
 *
 * Observed (run c4f47e34): Overture division_area failed this route twice at
 * ~2.1 minutes each, so the question pre-step dropped it — while the code that
 * ultimately answered the question read that table's bbox and names columns with
 * no profile at all. Statistics improve plans; they were never a precondition
 * for access. The route now degrades to the DESCRIBE floor instead of 500ing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  profileError: null as Error | null,
  describeCalls: 0,
  profileCalls: 0,
  cacheWrites: 0,
  stored: [] as { csvId: string; columns: number }[],
}));

const schemaOf = (kind: "number" | "unprofiled") => ({
  csv_id: "",
  filename: "division_area",
  row_count: 1000,
  columns: [
    {
      name: "geometry",
      dtype: "string",
      null_count: 0,
      sample_values: [],
      meta:
        kind === "unprofiled"
          ? { kind: "unprofiled", reason: "schema read only — no rows were read for statistics" }
          : {
              kind: "categorical",
              distinct_count: 5,
              avg_length: 3,
              max_length: 4,
              min_length: 2,
              is_unique: false,
            },
    },
  ],
  sample_rows: [],
});

vi.mock("@/lib/local-files/security", () => ({ validateLocalOrigin: () => true }));
vi.mock("@/lib/runtime-config", () => ({
  getActiveSandboxRuntime: () => "docker",
  getProfileDepth: () => 50_000,
}));
vi.mock("@/lib/parquet/schema-extractor", () => ({
  extractRemoteParquetSchema: vi.fn(async () => {
    state.profileCalls++;
    if (state.profileError) throw state.profileError;
    return schemaOf("number");
  }),
  describeRemoteParquet: vi.fn(async () => {
    state.describeCalls++;
    return schemaOf("unprofiled");
  }),
  computeRemoteParquetFingerprint: vi.fn(async () => "fp-1"),
}));
vi.mock("@/lib/schema-cache", () => ({
  resolveWithCache: vi.fn(
    async (args: { extract: () => Promise<unknown>; fingerprint: () => Promise<string> }) => {
      await args.fingerprint();
      const artifact = await args.extract();
      state.cacheWrites++;
      return { artifact, status: "miss" };
    }
  ),
  readWasmSchemaCache: vi.fn(async () => null),
}));
vi.mock("@/lib/csv/storage", () => ({
  storeRemoteParquetRef: vi.fn((csvId: string, schema: { columns: unknown[] }) => {
    state.stored.push({ csvId, columns: schema.columns.length });
  }),
}));
vi.mock("@/lib/sources/recent-sources", () => ({
  recordRecentSource: vi.fn(async () => {}),
  remoteHostName: () => "overturemaps",
}));

import { POST } from "@/app/api/remote-parquet/schema/route";

async function call() {
  const res = await POST(
    new Request("http://localhost/api/remote-parquet/schema", {
      method: "POST",
      body: JSON.stringify({
        url: "s3://overturemaps/release/theme=divisions/type=division_area/*.parquet",
      }),
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  state.profileError = null;
  state.describeCalls = 0;
  state.profileCalls = 0;
  state.cacheWrites = 0;
  state.stored = [];
});

describe("profile failure degrades to the describe floor", () => {
  it("returns a usable schema instead of a 500 when the profile times out", async () => {
    state.profileError = new Error("Command timed out after 120000ms");
    const { status, body } = await call();

    expect(status).toBe(200);
    expect(body.profile_tier).toBe("described");
    const schema = body.schema as { columns: { meta: { kind: string } }[] };
    expect(schema.columns).toHaveLength(1);
    // Usable AND honest: the column is there, explicitly unmeasured.
    expect(schema.columns[0]!.meta.kind).toBe("unprofiled");
    expect(state.describeCalls).toBe(1);
    // The table is registered, so a question can actually reference it.
    expect(state.stored).toHaveLength(1);
  });

  it("does NOT cache the describe-only result under the profile's key", async () => {
    // A describe-only artifact stored there would read as a successful profile
    // forever and permanently block the upgrade. Seconds to redo beats that.
    state.profileError = new Error("boom");
    await call();
    expect(state.cacheWrites).toBe(0);
  });

  it("a successful profile is unchanged — no describe call, normal caching", async () => {
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.profile_tier).toBe("profiled");
    expect(body.cache_status).toBe("miss");
    expect(state.describeCalls).toBe(0);
    expect(state.profileCalls).toBe(1);
    expect(state.cacheWrites).toBe(1);
  });

  it("surfaces a real error only when even DESCRIBE fails — the true fail-closed case", async () => {
    const { describeRemoteParquet } = await import("@/lib/parquet/schema-extractor");
    state.profileError = new Error("profile boom");
    (describeRemoteParquet as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("no such bucket")
    );
    const { status, body } = await call();
    expect(status).toBe(500);
    expect(String(body.error)).toContain("no such bucket");
  });
});
