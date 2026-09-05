import { describe, it, expect, vi } from "vitest";
import {
  materializeEntities,
  ensureManifestEntities,
  targetFor,
  type MaterializeDeps,
} from "@/lib/manifest/ensure";
import type { BatchOutcome } from "@/lib/manifest/connect";
import type { ManifestRecord, EntityState } from "@/lib/manifest/store";
import type { ManifestEntity } from "@/lib/contracts/dataset-manifest";
import type { CSVSchema } from "@/lib/contracts/data-schema";

/**
 * The shared materializer (spec §6 MCP parity). connect.ts routes through it
 * eagerly and MCP's question path routes through it lazily, so what these pin
 * is the NON-DRIFT contract: cache-first, budget misses stay pending (never
 * failed — a retry must remain possible), one bad entity never sinks the rest,
 * and an already-ready entity keeps its live csvId untouched.
 */

const HOST = "https://data.example.org";

const entity = (name: string, over: Partial<ManifestEntity> = {}): ManifestEntity => ({
  name,
  url: `${HOST}/data/${name}.parquet`,
  ...over,
});

const schemaFor = (name: string): CSVSchema => ({
  csv_id: "",
  filename: name,
  row_count: 42,
  columns: [{ name: "x", dtype: "number", null_count: 0, meta: { kind: "number" } }] as never,
  sample_rows: [],
  detected_domain: "general",
});

function deps(overrides: Partial<MaterializeDeps> = {}): MaterializeDeps & {
  registered: { csvId: string; readUrl: string; isHive: boolean }[];
} {
  let n = 0;
  const registered: { csvId: string; readUrl: string; isHive: boolean }[] = [];
  return {
    registered,
    readCachedSchema: vi.fn(async () => null),
    writeCachedSchema: vi.fn(async () => {}),
    extractBatch: vi.fn(async (targets: { name: string }[]): Promise<BatchOutcome> => ({
      results: new Map(targets.map((t) => [t.name, { schema: schemaFor(t.name) }])),
      skipped: [],
    })),
    registerEntity: (csvId, _schema, readUrl, _creds, isHive) =>
      registered.push({ csvId, readUrl, isHive }),
    newId: () => `id-${++n}`,
    ...overrides,
  };
}

const HASH = "f".repeat(64);

function recordWith(states: [string, EntityState][]): ManifestRecord {
  return {
    manifestId: "m-1",
    manifest: {
      title: "t",
      format: "files-array",
      entities: states.map(([, s]) => s.entity),
    } as never,
    excluded: [],
    entities: new Map(states),
    manifestHash: HASH,
    connectedAt: 1_000,
  };
}

describe("materializeEntities", () => {
  it("cache hit registers WITHOUT extraction; a miss extracts; both come back ready", async () => {
    // Only "a" is cached — the source key carries the read url.
    const d = deps({
      readCachedSchema: vi.fn(async (key: string) =>
        key.includes("/a.parquet") ? schemaFor("a") : null
      ),
    });
    const r = await materializeEntities({
      entities: [entity("a"), entity("b")],
      manifestHash: HASH,
      deps: d,
      budgetMs: 1000,
      eagerCapable: true,
    });
    expect(r.fromCache).toBe(1);
    expect(r.skipped).toEqual([]);
    expect(r.states.get("a")?.status).toBe("ready");
    expect(r.states.get("b")?.status).toBe("ready");
    // The extractor saw ONLY the miss — a cache hit must never re-extract.
    expect(d.extractBatch).toHaveBeenCalledTimes(1);
    expect((d.extractBatch as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual([
      expect.objectContaining({ name: "b" }),
    ]);
    // A cache hit's schema is written back by nobody (it came FROM the cache).
    expect(d.writeCachedSchema).toHaveBeenCalledTimes(1);
  });

  it("force skips the cache and re-extracts everything", async () => {
    const d = deps({ readCachedSchema: vi.fn(async () => schemaFor("cached")) });
    const r = await materializeEntities({
      entities: [entity("a")],
      manifestHash: HASH,
      deps: d,
      budgetMs: 1000,
      force: true,
      eagerCapable: true,
    });
    expect(d.readCachedSchema).not.toHaveBeenCalled();
    expect(d.extractBatch).toHaveBeenCalledTimes(1);
    expect(r.fromCache).toBe(0);
    expect(r.states.get("a")?.status).toBe("ready");
  });

  it("one unreadable entity fails ALONE — the others still come back ready", async () => {
    const d = deps({
      extractBatch: vi.fn(async (targets: { name: string }[]): Promise<BatchOutcome> => ({
        results: new Map<string, { schema: CSVSchema } | { error: string }>(
          targets.map((t) => [
            t.name,
            t.name === "bad" ? { error: "403 from the source" } : { schema: schemaFor(t.name) },
          ])
        ),
        skipped: [],
      })),
    });
    const r = await materializeEntities({
      entities: [entity("good"), entity("bad")],
      manifestHash: HASH,
      deps: d,
      budgetMs: 1000,
      eagerCapable: true,
    });
    expect(r.states.get("good")?.status).toBe("ready");
    expect(r.states.get("bad")).toMatchObject({ status: "failed", error: "403 from the source" });
    // The good entity is registered; the bad one never is.
    expect(d.registered.map((x) => x.readUrl)).toEqual([`${HOST}/data/good.parquet`]);
  });

  it("a budget miss is SKIPPED (no state), never marked failed", async () => {
    const d = deps({
      extractBatch: vi.fn(async (): Promise<BatchOutcome> => ({
        results: new Map(),
        skipped: ["slow"],
      })),
    });
    const r = await materializeEntities({
      entities: [entity("slow")],
      manifestHash: HASH,
      deps: d,
      budgetMs: 1,
      eagerCapable: true,
    });
    // No state at all: the CALLER records pending. Failed here would poison a retry.
    expect(r.states.has("slow")).toBe(false);
    expect(r.skipped).toEqual(["slow"]);
  });

  it("no batch extractor (eagerCapable=false): a no-op, not a throw — all skipped", async () => {
    const d = deps();
    const r = await materializeEntities({
      entities: [entity("a"), entity("b")],
      manifestHash: HASH,
      deps: d,
      budgetMs: 1000,
      eagerCapable: false,
    });
    expect(d.extractBatch).not.toHaveBeenCalled();
    expect(r.states.size).toBe(0);
    expect(r.skipped).toEqual(["a", "b"]);
  });

  it("a failed cache write never fails the materialization", async () => {
    const d = deps({
      writeCachedSchema: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const r = await materializeEntities({
      entities: [entity("a")],
      manifestHash: HASH,
      deps: d,
      budgetMs: 1000,
      eagerCapable: true,
    });
    expect(r.states.get("a")?.status).toBe("ready");
  });
});

describe("ensureManifestEntities", () => {
  it("an already-ready entity keeps its LIVE csvId — no re-extraction, no new id", async () => {
    const e = entity("a");
    const d = deps();
    const record = recordWith([
      ["a", { entity: e, status: "ready", csvId: "live-7", rowCount: 42, columnCount: 1 }],
    ]);
    const r = await ensureManifestEntities({
      record,
      names: ["a"],
      deps: d,
      budgetMs: 1000,
      eagerCapable: true,
    });
    expect(r.ready).toEqual([{ name: "a", csvId: "live-7" }]);
    expect(r.unavailable).toEqual([]);
    expect(d.extractBatch).not.toHaveBeenCalled();
    expect(d.registered).toEqual([]);
  });

  it("promotes a pending entity to ready IN THE RECORD", async () => {
    const e = entity("a");
    const d = deps();
    const record = recordWith([["a", { entity: e, status: "pending" }]]);
    const r = await ensureManifestEntities({
      record,
      names: ["a"],
      deps: d,
      budgetMs: 1000,
      eagerCapable: true,
    });
    expect(r.ready).toEqual([{ name: "a", csvId: "id-1" }]);
    // The record mutated in place — the next question sees ready directly.
    expect(record.entities.get("a")).toMatchObject({ status: "ready", csvId: "id-1" });
  });

  it("rejects an unknown name without touching the extractor", async () => {
    const d = deps();
    const record = recordWith([["a", { entity: entity("a"), status: "pending" }]]);
    const r = await ensureManifestEntities({
      record,
      names: ["nope"],
      deps: d,
      budgetMs: 1000,
      eagerCapable: true,
    });
    expect(r.ready).toEqual([]);
    expect(r.unavailable).toEqual([{ name: "nope", reason: "not an entity of this manifest" }]);
    expect(d.extractBatch).not.toHaveBeenCalled();
  });

  it("a budget miss surfaces as retryable-unavailable and the record STAYS pending", async () => {
    const d = deps({
      extractBatch: vi.fn(async (): Promise<BatchOutcome> => ({
        results: new Map(),
        skipped: ["a"],
      })),
    });
    const record = recordWith([["a", { entity: entity("a"), status: "pending" }]]);
    const r = await ensureManifestEntities({
      record,
      names: ["a"],
      deps: d,
      budgetMs: 1,
      eagerCapable: true,
    });
    expect(r.ready).toEqual([]);
    expect(r.unavailable).toEqual([
      { name: "a", reason: "introspection budget exhausted — retry" },
    ]);
    // NOT failed: pending is what makes the next attempt possible.
    expect(record.entities.get("a")?.status).toBe("pending");
  });

  it("wasm fallback: extractOne materializes what no batch extractor could, with the SAME cache write", async () => {
    const d = deps();
    const extractOne = vi.fn(async (_t: unknown, _c: unknown, _id: string, name: string) =>
      schemaFor(name)
    );
    const record = recordWith([["a", { entity: entity("a"), status: "pending" }]]);
    const r = await ensureManifestEntities({
      record,
      names: ["a"],
      deps: d,
      budgetMs: 1000,
      eagerCapable: false, // no docker — the web app's client would drive this; MCP has none
      extractOne,
    });
    expect(d.extractBatch).not.toHaveBeenCalled();
    expect(extractOne).toHaveBeenCalledTimes(1);
    expect(r.ready).toEqual([{ name: "a", csvId: "id-1" }]);
    expect(record.entities.get("a")).toMatchObject({ status: "ready", csvId: "id-1" });
    // The cache write uses the batch path's key+fingerprint — a later docker
    // session must hit what this wrote.
    expect(d.writeCachedSchema).toHaveBeenCalledTimes(1);
    expect(d.registered.map((x) => x.readUrl)).toEqual([`${HOST}/data/a.parquet`]);
  });

  it("wasm fallback: one extractOne failure marks THAT entity failed, others ready", async () => {
    const d = deps();
    const extractOne = vi.fn(async (_t: unknown, _c: unknown, _id: string, name: string) => {
      if (name === "bad") throw new Error("footer unreadable");
      return schemaFor(name);
    });
    const record = recordWith([
      ["good", { entity: entity("good"), status: "pending" }],
      ["bad", { entity: entity("bad"), status: "pending" }],
    ]);
    const r = await ensureManifestEntities({
      record,
      names: ["good", "bad"],
      deps: d,
      budgetMs: 1000,
      eagerCapable: false,
      extractOne,
    });
    expect(r.ready).toEqual([{ name: "good", csvId: "id-1" }]);
    expect(r.unavailable).toEqual([{ name: "bad", reason: "footer unreadable" }]);
    expect(record.entities.get("bad")?.status).toBe("failed");
  });

  it("a per-entity failure lands in unavailable with ITS error; others stay usable", async () => {
    const d = deps({
      extractBatch: vi.fn(async (targets: { name: string }[]): Promise<BatchOutcome> => ({
        results: new Map<string, { schema: CSVSchema } | { error: string }>(
          targets.map((t) => [
            t.name,
            t.name === "bad" ? { error: "not parquet" } : { schema: schemaFor(t.name) },
          ])
        ),
        skipped: [],
      })),
    });
    const record = recordWith([
      ["good", { entity: entity("good"), status: "pending" }],
      ["bad", { entity: entity("bad"), status: "pending" }],
    ]);
    const r = await ensureManifestEntities({
      record,
      names: ["good", "bad"],
      deps: d,
      budgetMs: 1000,
      eagerCapable: true,
    });
    expect(r.ready).toEqual([{ name: "good", csvId: "id-1" }]);
    expect(r.unavailable).toEqual([{ name: "bad", reason: "not parquet" }]);
    expect(record.entities.get("bad")?.status).toBe("failed");
  });
});

describe("targetFor", () => {
  it("uses the single-URL normalizer — hive detection cannot fork between doors", () => {
    const t = targetFor(entity("hive", { url: `${HOST}/data/theme=x/*.parquet` }));
    expect(t.isHivePartitioned).toBe(true);
    const plain = targetFor(entity("plain"));
    expect(plain.isHivePartitioned).toBe(false);
    expect(plain.readUrl).toBe(`${HOST}/data/plain.parquet`);
  });
});
