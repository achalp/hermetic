/**
 * Schema cache core: the fingerprint-gated resolve flow (hit / miss / stale /
 * forced / probe-failed) and disk read/write, over an in-memory fs mock so no
 * test touches data/schema-cache/.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// In-memory "disk": absolute path → file contents.
const disk = new Map<string, string>();

vi.mock("fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async (path: string, data: string) => {
    disk.set(String(path), String(data));
  }),
  readFile: vi.fn(async (path: string) => {
    const v = disk.get(String(path));
    if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return v;
  }),
  unlink: vi.fn(async (path: string) => {
    disk.delete(String(path));
  }),
}));

vi.mock("@/lib/logger", () => ({
  errMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  resolveWithCache,
  readSchemaCache,
  writeSchemaCache,
  deleteSchemaCache,
} from "@/lib/schema-cache";

beforeEach(() => disk.clear());

describe("readSchemaCache / writeSchemaCache", () => {
  it("round-trips an artifact under a source key", async () => {
    await writeSchemaCache("s3://bucket/data", "fp-1", { cols: 3 });
    const entry = await readSchemaCache<{ cols: number }>("s3://bucket/data");
    expect(entry?.fingerprint).toBe("fp-1");
    expect(entry?.artifact).toEqual({ cols: 3 });
    expect(typeof entry?.cachedAt).toBe("number");
  });

  it("returns null for an absent key", async () => {
    expect(await readSchemaCache("nope")).toBeNull();
  });

  it("returns null for a corrupt entry (shape drift) rather than throwing", async () => {
    await writeSchemaCache("k", "fp", { a: 1 });
    // Corrupt the stored JSON in place.
    const anyKey = [...disk.keys()][0];
    disk.set(anyKey, JSON.stringify({ nonsense: true }));
    expect(await readSchemaCache("k")).toBeNull();
  });

  it("keys distinct sources to distinct files", async () => {
    await writeSchemaCache("a", "fpA", 1);
    await writeSchemaCache("b", "fpB", 2);
    expect((await readSchemaCache("a"))?.artifact).toBe(1);
    expect((await readSchemaCache("b"))?.artifact).toBe(2);
    expect(disk.size).toBe(2);
  });
});

describe("resolveWithCache", () => {
  const artifactV1 = { schema: "v1" };
  const artifactV2 = { schema: "v2" };

  it("MISS on first call: extracts, caches, returns miss", async () => {
    const extract = vi.fn(async () => artifactV1);
    const fingerprint = vi.fn(async () => "fp-1");
    const r = await resolveWithCache({ sourceKey: "src", fingerprint, extract });
    expect(r.status).toBe("miss");
    expect(r.artifact).toBe(artifactV1);
    expect(extract).toHaveBeenCalledTimes(1);
    // Cached under the current fingerprint.
    expect((await readSchemaCache("src"))?.fingerprint).toBe("fp-1");
  });

  it("HIT on a second call with an unchanged fingerprint: no extraction", async () => {
    const fingerprint = vi.fn(async () => "fp-1");
    await resolveWithCache({ sourceKey: "src", fingerprint, extract: async () => artifactV1 });

    const extract2 = vi.fn(async () => artifactV2);
    const r = await resolveWithCache({ sourceKey: "src", fingerprint, extract: extract2 });
    expect(r.status).toBe("hit");
    expect(r.artifact).toEqual(artifactV1); // the CACHED one, not v2
    expect(extract2).not.toHaveBeenCalled();
  });

  it("STALE when the fingerprint changes: re-extracts and re-caches", async () => {
    let fp = "fp-1";
    const fingerprint = vi.fn(async () => fp);
    await resolveWithCache({ sourceKey: "src", fingerprint, extract: async () => artifactV1 });

    fp = "fp-2"; // the source changed
    const extract2 = vi.fn(async () => artifactV2);
    const r = await resolveWithCache({ sourceKey: "src", fingerprint, extract: extract2 });
    expect(r.status).toBe("stale");
    expect(r.artifact).toBe(artifactV2);
    expect(extract2).toHaveBeenCalledTimes(1);
    expect((await readSchemaCache("src"))?.fingerprint).toBe("fp-2");
  });

  it("FORCED bypasses a valid cache, re-extracts, and overwrites so the next call hits", async () => {
    const fingerprint = vi.fn(async () => "fp-1");
    await resolveWithCache({ sourceKey: "src", fingerprint, extract: async () => artifactV1 });

    const extractForced = vi.fn(async () => artifactV2);
    const forced = await resolveWithCache({
      sourceKey: "src",
      fingerprint,
      extract: extractForced,
      force: true,
    });
    expect(forced.status).toBe("forced");
    expect(forced.artifact).toBe(artifactV2);
    expect(extractForced).toHaveBeenCalledTimes(1);
    // Overwrote the cache — a subsequent normal call hits the forced artifact.
    const after = await resolveWithCache({
      sourceKey: "src",
      fingerprint,
      extract: async () => artifactV1,
    });
    expect(after.status).toBe("hit");
    expect(after.artifact).toEqual(artifactV2); // from disk → new object, deep-equal
  });

  it("does not compute the fingerprint on a MISS-with-no-cache before extracting, but stores it after", async () => {
    const order: string[] = [];
    const fingerprint = vi.fn(async () => {
      order.push("fp");
      return "fp-1";
    });
    const extract = vi.fn(async () => {
      order.push("extract");
      return artifactV1;
    });
    await resolveWithCache({ sourceKey: "src", fingerprint, extract });
    // No cache existed, so extract runs first; fingerprint only to stamp the entry.
    expect(order).toEqual(["extract", "fp"]);
    expect(fingerprint).toHaveBeenCalledTimes(1);
  });

  it("a fingerprint-probe failure with a cached entry re-extracts (never serves maybe-stale)", async () => {
    await writeSchemaCache("src", "fp-1", artifactV1);
    const badProbe = vi.fn(async () => {
      throw new Error("network blip");
    });
    const extract = vi.fn(async () => artifactV2);
    const r = await resolveWithCache({ sourceKey: "src", fingerprint: badProbe, extract });
    expect(r.status).toBe("miss");
    expect(r.artifact).toBe(artifactV2);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  it("an extraction still caches even if the post-extract fingerprint probe throws", async () => {
    const fingerprint = vi.fn(async () => {
      throw new Error("probe down");
    });
    const r = await resolveWithCache({
      sourceKey: "src",
      fingerprint,
      extract: async () => artifactV1,
    });
    expect(r.status).toBe("miss");
    const entry = await readSchemaCache("src");
    expect(entry?.artifact).toEqual(artifactV1);
    expect(entry?.fingerprint).toMatch(/^probe-failed:/); // won't match a real fp → next call re-extracts
  });

  it("deleteSchemaCache forces a subsequent miss", async () => {
    const fingerprint = async () => "fp-1";
    await resolveWithCache({ sourceKey: "src", fingerprint, extract: async () => artifactV1 });
    await deleteSchemaCache("src");
    const extract = vi.fn(async () => artifactV2);
    const r = await resolveWithCache({ sourceKey: "src", fingerprint, extract });
    expect(r.status).toBe("miss");
    expect(extract).toHaveBeenCalledTimes(1);
  });
});
