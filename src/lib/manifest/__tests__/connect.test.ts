import { describe, it, expect, vi } from "vitest";
import {
  connectDatasetManifest,
  entityFingerprint,
  entitySourceKey,
  MANIFEST_EAGER_BUDGET_MS,
  type ConnectManifestDeps,
  type BatchOutcome,
} from "@/lib/manifest/connect";
import { createManifestStore } from "@/lib/manifest/store";
import { manifestView, entityDetail } from "@/lib/manifest/view";
import { ManifestError } from "@/lib/manifest/shared";
import type { CSVSchema } from "@/lib/contracts/data-schema";

/**
 * The connect orchestration (spec §5) with every impure edge injected — no
 * docker, no network, no disk. These pin the decisions: cache-first, eager
 * within the budget, pending beyond it, fail-closed on all-cross-host, and
 * every ready entity registered under the NORMALIZED read url.
 */

const HOST = "https://acct.blob.core.windows.net";
const M_URL = `${HOST}/data/manifest.json`;

const MANIFEST_TEXT = JSON.stringify({
  title: "Housing hub",
  files: [
    {
      name: "housing.parquet",
      url: `${HOST}/data/housing.parquet`,
      rows: 100,
      sha256: "a".repeat(64),
    },
    { name: "population.parquet", url: `${HOST}/data/population.parquet`, rows: 200 },
    { name: "evil.parquet", url: "https://evil.example.com/evil.parquet" },
  ],
});

const schemaFor = (name: string): CSVSchema => ({
  csv_id: "",
  filename: name,
  row_count: 42,
  columns: [{ name: "x", dtype: "number", null_count: 0, meta: { kind: "number" } }] as never,
  sample_rows: [],
  detected_domain: "general",
});

function deps(overrides: Partial<ConnectManifestDeps> = {}): ConnectManifestDeps & {
  registered: { csvId: string; readUrl: string; isHive: boolean }[];
} {
  let n = 0;
  const registered: { csvId: string; readUrl: string; isHive: boolean }[] = [];
  return {
    registered,
    fetchManifestText: vi.fn(async () => MANIFEST_TEXT),
    readCachedSchema: vi.fn(async () => null),
    writeCachedSchema: vi.fn(async () => {}),
    extractBatch: vi.fn(async (targets: { name: string }[]): Promise<BatchOutcome> => ({
      results: new Map(targets.map((t) => [t.name, { schema: schemaFor(t.name) }])),
      skipped: [],
    })),
    registerEntity: (csvId, _schema, readUrl, _creds, isHive) =>
      registered.push({ csvId, readUrl, isHive }),
    eagerCapable: () => true,
    store: createManifestStore(),
    newId: () => `id-${++n}`,
    now: () => 1_000,
    ...overrides,
  };
}

describe("connectDatasetManifest", () => {
  it("gates cross-host entities out, keeps the rest, and introspects eagerly", async () => {
    const d = deps();
    const { record } = await connectDatasetManifest({ url: M_URL }, d);

    expect(record.excluded.map((e) => e.name)).toEqual(["evil"]);
    expect([...record.entities.keys()]).toEqual(["housing", "population"]);
    expect([...record.entities.values()].every((e) => e.status === "ready")).toBe(true);
    // Ready entities are REGISTERED — from here the whole pipeline works on them.
    expect(d.registered.map((r) => r.readUrl)).toEqual([
      `${HOST}/data/housing.parquet`,
      `${HOST}/data/population.parquet`,
    ]);
    expect(d.store.get(record.manifestId)).toBe(record);
  });

  it("fails CLOSED when every entity is cross-host", async () => {
    const text = JSON.stringify({
      files: [{ name: "e.parquet", url: "https://evil.example.com/e.parquet" }],
    });
    await expect(
      connectDatasetManifest({ url: M_URL }, deps({ fetchManifestText: async () => text }))
    ).rejects.toThrow(/different host/);
  });

  it("serves cache hits WITHOUT extraction and reports them", async () => {
    const d = deps({
      readCachedSchema: vi.fn(async (_key, fp) =>
        fp === `msha:${"a".repeat(64)}` ? schemaFor("housing") : null
      ),
    });
    const { record, fromCache } = await connectDatasetManifest({ url: M_URL }, d);
    expect(fromCache).toBe(1);
    // Only the miss went to the batch.
    const batch = d.extractBatch as ReturnType<typeof vi.fn>;
    expect(batch.mock.calls[0]![0].map((t: { name: string }) => t.name)).toEqual(["population"]);
    expect(record.entities.get("housing")!.status).toBe("ready");
  });

  it("force skips the cache entirely", async () => {
    const read = vi.fn(async () => schemaFor("housing"));
    const d = deps({ readCachedSchema: read });
    await connectDatasetManifest({ url: M_URL, force: true }, d);
    expect(read).not.toHaveBeenCalled();
  });

  it("entities the budget skipped stay PENDING, not failed", async () => {
    const d = deps({
      extractBatch: async (targets) => ({
        results: new Map([[targets[0]!.name, { schema: schemaFor(targets[0]!.name) }]]),
        skipped: targets.slice(1).map((t) => t.name),
      }),
    });
    const { record } = await connectDatasetManifest({ url: M_URL }, d);
    expect(record.entities.get("housing")!.status).toBe("ready");
    expect(record.entities.get("population")!.status).toBe("pending");
  });

  it("a per-entity extraction FAILURE is recorded on that entity alone", async () => {
    const d = deps({
      extractBatch: async (targets) => {
        const results: BatchOutcome["results"] = new Map();
        for (const t of targets) {
          results.set(
            t.name,
            t.name === "housing" ? { error: "404 from the source" } : { schema: schemaFor(t.name) }
          );
        }
        return { results, skipped: [] };
      },
    });
    const { record } = await connectDatasetManifest({ url: M_URL }, d);
    expect(record.entities.get("housing")).toMatchObject({
      status: "failed",
      error: "404 from the source",
    });
    expect(record.entities.get("population")!.status).toBe("ready");
  });

  it("on a runtime with no docker extractor, misses stay pending (lazy for P3)", async () => {
    const batch = vi.fn();
    const d = deps({ eagerCapable: () => false, extractBatch: batch });
    const { record } = await connectDatasetManifest({ url: M_URL }, d);
    expect(batch).not.toHaveBeenCalled();
    expect([...record.entities.values()].every((e) => e.status === "pending")).toBe(true);
  });

  it("normalizes a FOLDER entity to the recursive glob and flags hive", async () => {
    const text = JSON.stringify({
      files: [{ name: "buildings", url: `${HOST}/release/theme=buildings/*.parquet` }],
    });
    const d = deps({ fetchManifestText: async () => text });
    await connectDatasetManifest({ url: M_URL }, d);
    expect(d.registered[0]).toMatchObject({
      readUrl: `${HOST}/release/theme=buildings/*.parquet`,
      isHive: true,
    });
  });

  it("writes the schema cache for eagerly-extracted entities", async () => {
    const write = vi.fn<(k: string, fp: string, s: CSVSchema) => Promise<void>>(async () => {});
    const d = deps({ writeCachedSchema: write });
    await connectDatasetManifest({ url: M_URL }, d);
    const fps = write.mock.calls.map((c) => c[1]);
    // housing carries a sha256 → msha fingerprint; population falls back to mhash.
    expect(fps.some((k) => k.startsWith("msha:"))).toBe(true);
    expect(fps.some((k) => k.startsWith("mhash:"))).toBe(true);
  });

  it("rejects an oversized manifest by SIZE, not with a JSON-parse error", async () => {
    const big = `{"files": [${"1,".repeat(0)}]}`.padEnd(8 * 1024 * 1024 + 1, " ");
    await expect(
      connectDatasetManifest({ url: M_URL }, deps({ fetchManifestText: async () => big }))
    ).rejects.toThrow(/larger than the 8 MB limit/);
  });

  it("keys the entity cache EXACTLY like the single-URL route, so they share lines", () => {
    expect(entitySourceKey("https://h/x.parquet")).toBe(`parquet:https://h/x.parquet:{}`);
    expect(entityFingerprint({ name: "e", url: "u", sha256: "f".repeat(64) }, "hash")).toBe(
      `msha:${"f".repeat(64)}`
    );
    expect(entityFingerprint({ name: "e", url: "u" }, "hash")).toBe("mhash:hash");
  });

  it("the eager budget is the reviewed one minute", () => {
    expect(MANIFEST_EAGER_BUDGET_MS).toBe(60_000);
  });
});

describe("views", () => {
  it("list view: hint rows until introspection, exact after — and flagged as such", async () => {
    const d = deps({
      extractBatch: async (targets) => ({
        results: new Map([[targets[0]!.name, { schema: schemaFor(targets[0]!.name) }]]),
        skipped: targets.slice(1).map((t) => t.name),
      }),
    });
    const { record } = await connectDatasetManifest({ url: M_URL }, d);
    const view = manifestView(record);
    const housing = view.entities.find((e) => e.name === "housing")!;
    const population = view.entities.find((e) => e.name === "population")!;
    expect(housing).toMatchObject({ rowCount: 42, rowCountIsExact: true, status: "ready" });
    expect(population).toMatchObject({ rowCount: 200, rowCountIsExact: false, status: "pending" });
    expect(view.excluded).toHaveLength(1);
    // The list view must stay LIGHT: no schemas in it.
    expect(JSON.stringify(view)).not.toContain("sample_rows");
  });

  it("entity detail resolves the stored schema by csvId", async () => {
    const d = deps();
    const { record } = await connectDatasetManifest({ url: M_URL }, d);
    const csvId = record.entities.get("housing")!.csvId!;
    const detail = entityDetail(record, "housing", (id) =>
      id === csvId ? schemaFor("housing") : undefined
    )!;
    expect(detail.schema?.row_count).toBe(42);
    expect(entityDetail(record, "nope", () => undefined)).toBeNull();
  });
});

describe("ManifestError surfaces as user-facing", () => {
  it("is what the fail-closed paths throw", async () => {
    await expect(
      connectDatasetManifest(
        { url: M_URL },
        deps({ fetchManifestText: async () => "not json at all" })
      )
    ).rejects.toThrow(ManifestError);
  });
});
