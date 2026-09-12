/**
 * The DESCRIBE floor in the shared ensure path (the MCP door).
 *
 * Run c4f47e34: the question pre-step picked building, division and
 * division_area; division_area's profile failed twice at ~2.1 minutes, so it was
 * dropped — and the code that answered the question went on to read that table's
 * bbox and names columns anyway. Statistics improve plans; losing a readable
 * table because its values could not be summarized is a scope change nobody asked
 * for.
 */
import { describe, it, expect, vi } from "vitest";
import { ensureManifestEntities, type MaterializeDeps } from "@/lib/manifest/ensure";
import type { ManifestRecord } from "@/lib/manifest/store";
import type { CSVSchema } from "@/lib/contracts/data-schema";

const schema = (name: string, profiled: boolean): CSVSchema => ({
  csv_id: "",
  filename: name,
  row_count: 100,
  sample_rows: [],
  columns: [
    {
      name: "geometry",
      dtype: "string",
      null_count: 0,
      sample_values: [],
      meta: profiled
        ? {
            kind: "categorical",
            distinct_count: 4,
            avg_length: 2,
            max_length: 3,
            min_length: 1,
            is_unique: false,
          }
        : { kind: "unprofiled", reason: "schema read only" },
    },
  ],
  profile_basis: profiled
    ? { kind: "leading_prefix", rows_examined: 50_000 }
    : { kind: "metadata", rows_examined: 0 },
});

function record(names: string[]): ManifestRecord {
  return {
    manifestId: "m1",
    manifest: {
      manifestUrl: "https://h/c.json",
      format: "stac",
      entities: [],
    } as ManifestRecord["manifest"],
    excluded: [],
    manifestHash: "h1",
    connectedAt: 0,
    entities: new Map(
      names.map((n) => [
        n,
        { entity: { name: n, url: `s3://b/${n}/*.parquet` }, status: "pending" as const },
      ])
    ),
  };
}

function deps(over: Partial<MaterializeDeps> = {}): MaterializeDeps {
  let n = 0;
  return {
    readCachedSchema: async () => null,
    writeCachedSchema: async () => {},
    extractBatch: async (targets) => ({
      results: new Map(targets.map((t) => [t.name, { error: "timed out after 120000ms" }])),
      skipped: [],
    }),
    registerEntity: vi.fn(),
    newId: () => `csv-${++n}`,
    ...over,
  };
}

describe("ensureManifestEntities — describe floor", () => {
  it("keeps an entity whose PROFILE failed but whose schema can be read", async () => {
    const describeOne = vi.fn(async (_t, _c, csvId: string, filename: string) => ({
      ...schema(filename, false),
      csv_id: csvId,
    }));
    const registerEntity = vi.fn();
    const rec = record(["division_area"]);

    const { ready, unavailable } = await ensureManifestEntities({
      record: rec,
      names: ["division_area"],
      deps: deps({ describeOne, registerEntity }),
      budgetMs: 1000,
      eagerCapable: true,
    });

    expect(describeOne).toHaveBeenCalledTimes(1);
    expect(ready.map((r) => r.name)).toEqual(["division_area"]);
    expect(unavailable).toEqual([]);
    // Registered, so generated SQL can actually reference it.
    expect(registerEntity).toHaveBeenCalledTimes(1);
    // And the entity is ready in the record the question will read.
    expect(rec.entities.get("division_area")!.status).toBe("ready");
  });

  it("does NOT cache the describe-only schema — it must not block a later profile", async () => {
    const writeCachedSchema = vi.fn(async () => {});
    await ensureManifestEntities({
      record: record(["a"]),
      names: ["a"],
      deps: deps({
        writeCachedSchema,
        describeOne: async (_t, _c, csvId, filename) => ({
          ...schema(filename, false),
          csv_id: csvId,
        }),
      }),
      budgetMs: 1000,
      eagerCapable: true,
    });
    expect(writeCachedSchema).not.toHaveBeenCalled();
  });

  it("reports unavailable only when even DESCRIBE fails", async () => {
    const { ready, unavailable } = await ensureManifestEntities({
      record: record(["ghost"]),
      names: ["ghost"],
      deps: deps({
        describeOne: async () => {
          throw new Error("no such bucket");
        },
      }),
      budgetMs: 1000,
      eagerCapable: true,
    });
    expect(ready).toEqual([]);
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]!.name).toBe("ghost");
  });

  it("leaves a SUCCESSFUL profile alone — the floor is a fallback, not a replacement", async () => {
    const describeOne = vi.fn();
    const { ready } = await ensureManifestEntities({
      record: record(["building"]),
      names: ["building"],
      deps: deps({
        describeOne,
        extractBatch: async (targets) => ({
          results: new Map(targets.map((t) => [t.name, { schema: schema(t.name, true) }])),
          skipped: [],
        }),
      }),
      budgetMs: 1000,
      eagerCapable: true,
    });
    expect(describeOne).not.toHaveBeenCalled();
    expect(ready.map((r) => r.name)).toEqual(["building"]);
  });

  it("without a describeOne dep the old behaviour stands (entity unavailable)", async () => {
    const { ready, unavailable } = await ensureManifestEntities({
      record: record(["division_area"]),
      names: ["division_area"],
      deps: deps(),
      budgetMs: 1000,
      eagerCapable: true,
    });
    expect(ready).toEqual([]);
    expect(unavailable[0]!.name).toBe("division_area");
  });
});
