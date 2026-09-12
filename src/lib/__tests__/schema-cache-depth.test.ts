/**
 * The cache's `accept` gate — why a profile depth is NOT part of source identity.
 *
 * Raising the profile-depth setting does not change the source, so a
 * fingerprint-only cache would keep serving the shallow profile forever. Folding
 * depth into the fingerprint (or the sourceKey) fixes that but breaks two other
 * things: a SHALLOWER request would re-extract a perfectly good deep profile, and
 * one source would fragment into an entry per depth.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWithCache, writeSchemaCache } from "@/lib/schema-cache";
import { setPathRoots } from "@/lib/paths";
import { profileSatisfiesDepth } from "@/lib/parquet/profile-depth";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hermetic-depth-"));
  setPathRoots({ dataRoot: dir });
});
afterEach(() => {
  setPathRoots({});
  rmSync(dir, { recursive: true, force: true });
});

const artifactAt = (rows: number, kind = "leading_prefix") => ({
  row_count: 1_000_000,
  profile_basis: { kind, rows_examined: rows },
});

/** The REAL gate the remote-parquet route installs — imported, not re-implemented,
 *  so a drift in the rule fails here instead of passing against a copy. */
const acceptFor =
  (depth: number) => (a: { profile_basis?: { kind: string; rows_examined: number } }) =>
    profileSatisfiesDepth(a.profile_basis as never, depth);

describe("depth-aware cache reuse", () => {
  const KEY = "parquet:s3://b/x.parquet:{}";
  const fingerprint = () => Promise.resolve("fp-1");

  it("re-extracts when the cached profile is SHALLOWER than the request", async () => {
    await writeSchemaCache(KEY, "fp-1", artifactAt(50_000));
    const extract = vi.fn(async () => artifactAt(500_000));
    const { status } = await resolveWithCache({
      sourceKey: KEY,
      fingerprint,
      extract,
      accept: acceptFor(500_000),
    });
    expect(extract).toHaveBeenCalledOnce();
    expect(status).toBe("stale");
  });

  it("reuses a DEEPER cached profile for a shallower request — never re-reads to get less", async () => {
    await writeSchemaCache(KEY, "fp-1", artifactAt(500_000));
    const extract = vi.fn(async () => artifactAt(50_000));
    const { status, artifact } = await resolveWithCache({
      sourceKey: KEY,
      fingerprint,
      extract,
      accept: acceptFor(50_000),
    });
    expect(extract).not.toHaveBeenCalled();
    expect(status).toBe("hit");
    expect(artifact.profile_basis.rows_examined).toBe(500_000);
  });

  it("reuses a FULL SCAN at any depth — there is nothing deeper to read", async () => {
    await writeSchemaCache(KEY, "fp-1", artifactAt(1_000, "full_scan"));
    const extract = vi.fn(async () => artifactAt(500_000));
    const { status } = await resolveWithCache({
      sourceKey: KEY,
      fingerprint,
      extract,
      accept: acceptFor(500_000),
    });
    expect(extract).not.toHaveBeenCalled();
    expect(status).toBe("hit");
  });

  it("treats a pre-provenance entry as good enough only at the default depth", async () => {
    // Entries cached before profile_basis existed carry no depth. Assuming they
    // are deep would serve a shallow profile to a user who asked for more;
    // assuming they are shallow would re-extract everyone's cache on upgrade.
    await writeSchemaCache(KEY, "fp-1", { row_count: 10 });
    const deep = vi.fn(async () => artifactAt(500_000));
    expect(
      (
        await resolveWithCache({
          sourceKey: KEY,
          fingerprint,
          extract: deep,
          accept: acceptFor(500_000),
        })
      ).status
    ).toBe("stale");

    await writeSchemaCache(KEY, "fp-1", { row_count: 10 });
    const shallow = vi.fn(async () => artifactAt(50_000));
    expect(
      (
        await resolveWithCache({
          sourceKey: KEY,
          fingerprint,
          extract: shallow,
          accept: acceptFor(50_000),
        })
      ).status
    ).toBe("hit");
    expect(shallow).not.toHaveBeenCalled();
  });

  it("a changed source still wins over any depth reasoning", async () => {
    await writeSchemaCache(KEY, "fp-OLD", artifactAt(500_000));
    const extract = vi.fn(async () => artifactAt(50_000));
    const { status } = await resolveWithCache({
      sourceKey: KEY,
      fingerprint,
      extract,
      accept: acceptFor(50_000),
    });
    expect(extract).toHaveBeenCalledOnce();
    expect(status).toBe("stale");
  });

  it("without an accept gate the behaviour is exactly as before", async () => {
    await writeSchemaCache(KEY, "fp-1", artifactAt(50_000));
    const extract = vi.fn(async () => artifactAt(500_000));
    const { status } = await resolveWithCache({ sourceKey: KEY, fingerprint, extract });
    expect(extract).not.toHaveBeenCalled();
    expect(status).toBe("hit");
  });
});
