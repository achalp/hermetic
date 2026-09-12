/**
 * /api/manifest/connect composition-root test: the PROFILE-ON-DEMAND policy.
 *
 * Connect lists a catalog and reads the schema CACHE; it must never run the
 * batch extractor, on any runtime. Value profiling costs ~50s of remote egress
 * per entity (measured on Overture division_area), so doing it for a whole
 * catalog at connect spent minutes on tables nobody asked about — and on a
 * warehouse with a thousand of them it could never finish. The extractor runs
 * when a question needs an entity, or when the user profiles one explicitly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  manifestText: JSON.stringify({
    name: "catalog",
    resources: [
      { name: "housing", path: "https://h/data/housing.parquet" },
      { name: "population", path: "https://h/data/population.parquet" },
    ],
  }),
  cache: new Map<string, { fingerprint: string; artifact: unknown }>(),
  batchCalls: 0,
}));

vi.mock("@/lib/local-files/security", () => ({ validateLocalOrigin: () => true }));
vi.mock("@/lib/manifest/fetch", () => ({
  fetchManifestText: vi.fn(async () => state.manifestText),
}));
vi.mock("@/lib/parquet/schema-extractor", () => ({
  extractRemoteParquetSchemaBatch: vi.fn(async () => {
    state.batchCalls++;
    return { results: new Map(), skipped: [] };
  }),
}));
vi.mock("@/lib/schema-cache", () => ({
  readSchemaCache: vi.fn(async (key: string) => state.cache.get(key) ?? null),
  writeSchemaCache: vi.fn(async () => {}),
}));
vi.mock("@/lib/manifest/failure-memory", () => ({
  recentFailure: vi.fn(async () => null),
  rememberFailure: vi.fn(async () => {}),
  clearFailure: vi.fn(async () => {}),
}));
vi.mock("@/lib/csv/storage", () => ({ storeRemoteParquetRef: vi.fn() }));
vi.mock("@/lib/sources/recent-sources", () => ({
  recordRecentSource: vi.fn(async () => {}),
  manifestHostName: () => "h",
}));

import { POST } from "@/app/api/manifest/connect/route";
import { entitySourceKey } from "@/lib/manifest/connect";

async function connect() {
  const res = await POST(
    new Request("http://localhost/api/manifest/connect", {
      method: "POST",
      body: JSON.stringify({ url: "https://h/data/manifest.json" }),
    })
  );
  const lines = (await res.text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const result = lines.find((l) => l.type === "result");
  if (!result) throw new Error(`no result line: ${JSON.stringify(lines)}`);
  return result.view as {
    entities: { name: string; status: string; columnCount?: number }[];
  };
}

beforeEach(() => {
  state.cache.clear();
  state.batchCalls = 0;
});

describe("/api/manifest/connect — profile on demand", () => {
  it("lists the catalog without profiling anything", async () => {
    const view = await connect();
    expect(view.entities.map((e) => e.name)).toEqual(["housing", "population"]);
    expect(view.entities.every((e) => e.status === "pending")).toBe(true);
    expect(state.batchCalls).toBe(0);
  });

  it("still serves entities profiled in an EARLIER session from the cache", async () => {
    // A previous profile of "population" — the free cache pass must find it, so
    // profile-on-demand never re-reads what is already known.
    state.cache.set(entitySourceKey("https://h/data/population.parquet", undefined), {
      fingerprint: `mhash:${
        // the manifest hash the route computes for this exact document
        (await import("node:crypto")).createHash("sha256").update(state.manifestText).digest("hex")
      }`,
      artifact: {
        csv_id: "c-pop",
        filename: "population",
        row_count: 42,
        columns: [{ name: "x", dtype: "number" }],
        sample_rows: [],
      },
    });
    const view = await connect();
    const byName = Object.fromEntries(view.entities.map((e) => [e.name, e]));
    expect(byName.population!.status).toBe("ready");
    expect(byName.housing!.status).toBe("pending");
    expect(state.batchCalls).toBe(0);
  });
});
