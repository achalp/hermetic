import { describe, it, expect } from "vitest";
import { fetchManifestText } from "@/lib/manifest/fetch";
import { resolveStacManifest, looksLikeStac } from "@/lib/manifest/stac";

/**
 * LIVE gate for the STAC adapter: the real Overture catalog through the real
 * egress-vetted fetcher (the Rust bin — requires it built and network access).
 * Run: HERMETIC_LIVE_STAC_TEST=1 npx vitest run src/lib/manifest/__tests__/stac-live.test.ts
 */
const gated = process.env.HERMETIC_LIVE_STAC_TEST ? describe : describe.skip;

gated("Overture STAC catalog (live)", () => {
  it("resolves the latest release into per-type entities with hints and docs", async () => {
    const url = "https://stac.overturemaps.org/catalog.json";
    const text = await fetchManifestText(url);
    const root = JSON.parse(text) as unknown;
    expect(looksLikeStac(root)).toBe(true);

    const m = await resolveStacManifest(root, url, {
      fetchText: (u) => fetchManifestText(u),
    });
    expect(m.format).toBe("stac");
    const names = m.entities.map((e) => e.name);
    // The stable core types across releases.
    for (const expected of ["building", "building_part", "place", "division", "segment"]) {
      expect(names).toContain(expected);
    }
    const building = m.entities.find((e) => e.name === "building")!;
    // Multi-file type → s3:// glob on the Overture bucket.
    expect(building.url).toMatch(/^s3:\/\/overturemaps-us-west-2\/release\/.+\/\*\.parquet$/);
    expect(building.rowCountHint).toBeGreaterThan(1e9);
    // Live Overture table:columns carry names but (currently) no descriptions,
    // so columnDocs is legitimately absent — do not assert on it.
  }, 120_000);
});
