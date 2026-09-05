import { describe, it, expect } from "vitest";
import {
  looksLikeStac,
  pickItemAsset,
  resolveStacManifest,
  STAC_MAX_FETCHES,
} from "@/lib/manifest/stac";

/**
 * The STAC adapter (2026-08-31): a capped TRAVERSAL, not a pure adapter.
 * Fixtures mirror the live Overture catalog verified during recon (stac 1.1.0:
 * root with `latest` → release catalog → theme catalogs → collections with
 * table:row_count / table:columns and per-file items carrying aws + azure
 * assets). The fetcher is an in-memory doc map, so every traversal decision —
 * what got fetched, what got skipped — is observable.
 */

const CAT = "https://stac.example.org";
const S3 = "https://bucket.s3.us-west-2.amazonaws.com/release/2026-08-19.0";
const AZ = "https://acct.blob.core.windows.net/release/2026-08-19.0";

const link = (rel: string, href: string) => ({ rel, href });

function docs(): Record<string, unknown> {
  const item = (theme: string, type: string, part: string) => ({
    type: "Feature",
    id: part,
    assets: {
      azure: {
        href: `${AZ}/theme=${theme}/type=${type}/part-${part}.zstd.parquet`,
        type: "application/vnd.apache.parquet",
      },
      aws: {
        href: `${S3}/theme=${theme}/type=${type}/part-${part}.zstd.parquet`,
        type: "application/vnd.apache.parquet",
      },
    },
  });
  return {
    [`${CAT}/catalog.json`]: {
      type: "Catalog",
      stac_version: "1.1.0",
      id: "Releases",
      title: "Example Releases",
      latest: "2026-08-19.0",
      links: [
        link("child", `${CAT}/2026-08-19.0/catalog.json`),
        link("child", `${CAT}/2026-07-22.0/catalog.json`),
      ],
    },
    [`${CAT}/2026-08-19.0/catalog.json`]: {
      type: "Catalog",
      stac_version: "1.1.0",
      id: "2026-08-19.0",
      links: [
        link("child", `${CAT}/2026-08-19.0/buildings/catalog.json`),
        link("child", `${CAT}/2026-08-19.0/places/catalog.json`),
        // An off-host child must be SKIPPED (a catalog cannot chain origins).
        link("child", "https://evil.example.com/catalog.json"),
        link("parent", `${CAT}/catalog.json`),
      ],
    },
    [`${CAT}/2026-08-19.0/buildings/catalog.json`]: {
      type: "Catalog",
      stac_version: "1.1.0",
      id: "buildings",
      links: [
        link("child", `${CAT}/2026-08-19.0/buildings/building/collection.json`),
        link("child", `${CAT}/2026-08-19.0/buildings/building_part/collection.json`),
      ],
    },
    [`${CAT}/2026-08-19.0/places/catalog.json`]: {
      type: "Catalog",
      stac_version: "1.1.0",
      id: "places",
      links: [link("child", `${CAT}/2026-08-19.0/places/place/collection.json`)],
    },
    [`${CAT}/2026-08-19.0/buildings/building/collection.json`]: {
      type: "Collection",
      stac_version: "1.1.0",
      id: "building",
      title: "Buildings",
      description: "Global building footprints",
      "table:row_count": 2529582613,
      "table:columns": [
        { name: "height", description: "Height in meters" },
        { name: "id" }, // no description → not a columnDoc
      ],
      links: [
        // MANY items → the entity is the directory glob.
        link("item", `${CAT}/2026-08-19.0/buildings/building/00000/00000.json`),
        link("item", `${CAT}/2026-08-19.0/buildings/building/00001/00001.json`),
      ],
    },
    [`${CAT}/2026-08-19.0/buildings/building_part/collection.json`]: {
      type: "Collection",
      stac_version: "1.1.0",
      id: "building_part",
      "table:row_count": 4339150,
      // ONE item → the entity is the exact object URL.
      links: [link("item", `${CAT}/2026-08-19.0/buildings/building_part/00000/00000.json`)],
    },
    [`${CAT}/2026-08-19.0/places/place/collection.json`]: {
      type: "Collection",
      stac_version: "1.1.0",
      id: "place",
      links: [link("item", `${CAT}/2026-08-19.0/places/place/00000/00000.json`)],
    },
    [`${CAT}/2026-08-19.0/buildings/building/00000/00000.json`]: item(
      "buildings",
      "building",
      "00000"
    ),
    [`${CAT}/2026-08-19.0/buildings/building/00001/00001.json`]: item(
      "buildings",
      "building",
      "00001"
    ),
    [`${CAT}/2026-08-19.0/buildings/building_part/00000/00000.json`]: item(
      "buildings",
      "building_part",
      "00000"
    ),
    [`${CAT}/2026-08-19.0/places/place/00000/00000.json`]: item("places", "place", "00000"),
  };
}

function fetcher(map: Record<string, unknown>, log: string[] = []) {
  return {
    fetchText: async (url: string) => {
      log.push(url);
      const doc = map[url];
      if (doc === undefined) throw new Error(`404 ${url}`);
      return JSON.stringify(doc);
    },
  };
}

describe("looksLikeStac", () => {
  it("matches catalogs and collections with a stac_version, nothing else", () => {
    expect(looksLikeStac({ stac_version: "1.1.0", type: "Catalog" })).toBe(true);
    expect(looksLikeStac({ stac_version: "1.0.0", type: "Collection" })).toBe(true);
    expect(looksLikeStac({ type: "Catalog" })).toBe(false);
    expect(looksLikeStac({ stac_version: "1.1.0", type: "Feature" })).toBe(false);
    expect(looksLikeStac({ files: [] })).toBe(false);
  });
});

describe("pickItemAsset", () => {
  it("prefers the S3-identity asset — LIST enumeration works there", () => {
    const href = pickItemAsset({
      assets: {
        azure: { href: `${AZ}/x.parquet`, type: "application/vnd.apache.parquet" },
        aws: { href: `${S3}/x.parquet`, type: "application/vnd.apache.parquet" },
      },
    });
    expect(href).toBe(`${S3}/x.parquet`);
  });

  it("prefers Azure Blob over a host with no listing — enumeration works there too", () => {
    // Only the LISTABLE mirror keeps a multi-file collection alive; picking the
    // plain-https asset would get the whole entity skipped.
    expect(
      pickItemAsset({
        assets: {
          mirror: { href: "https://files.example.org/x.parquet" },
          azure: { href: `${AZ}/x.parquet`, type: "application/vnd.apache.parquet" },
        },
      })
    ).toBe(`${AZ}/x.parquet`);
  });

  it("falls back to the first parquet asset; ignores non-parquet and non-http", () => {
    expect(
      pickItemAsset({
        assets: {
          tiles: { href: `${AZ}/x.pmtiles`, type: "application/vnd.pmtiles" },
          data: { href: `${AZ}/x.parquet`, type: "application/vnd.apache.parquet" },
          weird: { href: "s3://bucket/y.parquet" },
        },
      })
    ).toBe(`${AZ}/x.parquet`);
    expect(pickItemAsset({ assets: {} })).toBeNull();
    expect(pickItemAsset(null)).toBeNull();
  });
});

describe("resolveStacManifest — the Overture shape", () => {
  it("follows only the LATEST release and emits one entity per collection", async () => {
    const map = docs();
    const log: string[] = [];
    const m = await resolveStacManifest(
      map[`${CAT}/catalog.json`],
      `${CAT}/catalog.json`,
      fetcher(map, log)
    );

    expect(m.format).toBe("stac");
    expect(m.title).toBe("Example Releases");
    expect(m.entities.map((e) => e.name).sort()).toEqual(["building", "building_part", "place"]);
    // The stale release was never even fetched.
    expect(log.some((u) => u.includes("2026-07-22.0"))).toBe(false);
    // The off-host child was never fetched either.
    expect(log.some((u) => u.includes("evil.example.com"))).toBe(false);
  });

  it("many items → directory glob; one item → the exact object URL", async () => {
    const map = docs();
    const m = await resolveStacManifest(
      map[`${CAT}/catalog.json`],
      `${CAT}/catalog.json`,
      fetcher(map)
    );
    const building = m.entities.find((e) => e.name === "building")!;
    const part = m.entities.find((e) => e.name === "building_part")!;
    // Multi-file entities are s3:// form — what LIST enumeration + the
    // vhost-only egress derivation both speak.
    expect(building.url).toBe(
      "s3://bucket/release/2026-08-19.0/theme=buildings/type=building/*.parquet"
    );
    expect(part.url).toBe(`${S3}/theme=buildings/type=building_part/part-00000.zstd.parquet`);
  });

  it("carries row hints, descriptions, and documented columns to the entity", async () => {
    const map = docs();
    const m = await resolveStacManifest(
      map[`${CAT}/catalog.json`],
      `${CAT}/catalog.json`,
      fetcher(map)
    );
    const building = m.entities.find((e) => e.name === "building")!;
    expect(building.rowCountHint).toBe(2529582613);
    expect(building.description).toContain("Buildings");
    expect(building.description).toContain("Global building footprints");
    expect(building.columnDocs).toEqual([{ name: "height", description: "Height in meters" }]);
  });

  it("an unreadable sub-document is skipped; the rest of the tree still lands", async () => {
    const map = docs();
    delete map[`${CAT}/2026-08-19.0/places/place/collection.json`];
    const m = await resolveStacManifest(
      map[`${CAT}/catalog.json`],
      `${CAT}/catalog.json`,
      fetcher(map)
    );
    expect(m.entities.map((e) => e.name).sort()).toEqual(["building", "building_part"]);
  });

  it("a collection pasted DIRECTLY resolves without a catalog above it", async () => {
    const map = docs();
    const colUrl = `${CAT}/2026-08-19.0/buildings/building/collection.json`;
    const m = await resolveStacManifest(map[colUrl], colUrl, fetcher(map));
    expect(m.entities.map((e) => e.name)).toEqual(["building"]);
  });

  it("colliding collection ids get parent-qualified instead of overwritten", async () => {
    const map = docs();
    // A second theme that ALSO ships a "building" collection.
    (map[`${CAT}/2026-08-19.0/catalog.json`] as { links: unknown[] }).links = [
      link("child", `${CAT}/2026-08-19.0/buildings/catalog.json`),
      link("child", `${CAT}/2026-08-19.0/mirror/catalog.json`),
    ];
    map[`${CAT}/2026-08-19.0/mirror/catalog.json`] = {
      type: "Catalog",
      stac_version: "1.1.0",
      id: "mirror",
      links: [link("child", `${CAT}/2026-08-19.0/mirror/building/collection.json`)],
    };
    map[`${CAT}/2026-08-19.0/mirror/building/collection.json`] = {
      type: "Collection",
      stac_version: "1.1.0",
      id: "building",
      links: [link("item", `${CAT}/2026-08-19.0/mirror/building/00000/00000.json`)],
    };
    map[`${CAT}/2026-08-19.0/mirror/building/00000/00000.json`] = {
      type: "Feature",
      assets: { aws: { href: `${S3}/theme=mirror/type=building/part-0.parquet` } },
    };
    const m = await resolveStacManifest(
      map[`${CAT}/catalog.json`],
      `${CAT}/catalog.json`,
      fetcher(map)
    );
    const names = m.entities.map((e) => e.name).sort();
    expect(names).toContain("building");
    expect(names).toContain("mirror-building");
  });

  it("the fetch cap truncates SOFT — what was found is kept", async () => {
    // A catalog with more children than the cap allows.
    const map: Record<string, unknown> = {
      [`${CAT}/catalog.json`]: {
        type: "Catalog",
        stac_version: "1.1.0",
        id: "big",
        links: Array.from({ length: STAC_MAX_FETCHES + 20 }, (_, i) =>
          link("child", `${CAT}/c${i}/collection.json`)
        ),
      },
    };
    for (let i = 0; i < STAC_MAX_FETCHES + 20; i++) {
      map[`${CAT}/c${i}/collection.json`] = {
        type: "Collection",
        stac_version: "1.1.0",
        id: `c${i}`,
        links: [link("item", `${CAT}/c${i}/items/0.json`)],
      };
      map[`${CAT}/c${i}/items/0.json`] = {
        type: "Feature",
        assets: { aws: { href: `${S3}/c${i}/part-0.parquet` } },
      };
    }
    const m = await resolveStacManifest(
      map[`${CAT}/catalog.json`],
      `${CAT}/catalog.json`,
      fetcher(map)
    );
    expect(m.entities.length).toBeGreaterThan(0);
    expect(m.entities.length).toBeLessThan(STAC_MAX_FETCHES);
  });

  it("an off-host ITEM link drops that entity, not the traversal", async () => {
    const map = docs();
    (map[`${CAT}/2026-08-19.0/places/place/collection.json`] as { links: unknown[] }).links = [
      link("item", "https://evil.example.com/item.json"),
    ];
    const m = await resolveStacManifest(
      map[`${CAT}/catalog.json`],
      `${CAT}/catalog.json`,
      fetcher(map)
    );
    expect(m.entities.map((e) => e.name).sort()).toEqual(["building", "building_part"]);
  });
});

describe("toS3Url", () => {
  it("converts vhost hrefs (regional and global) and rejects non-S3 hosts", async () => {
    const { toS3Url } = await import("@/lib/manifest/stac");
    expect(toS3Url("https://b.s3.us-west-2.amazonaws.com/release/x.parquet")).toBe(
      "s3://b/release/x.parquet"
    );
    expect(toS3Url("https://b.s3.amazonaws.com/x.parquet")).toBe("s3://b/x.parquet");
    expect(toS3Url("https://acct.blob.core.windows.net/x.parquet")).toBeNull();
  });
});

describe("multi-file collections on non-S3 hosts", () => {
  const CAT2 = "https://stac.example.org";

  /** A two-item collection whose only parquet asset lives at `href`. */
  async function resolveWithAsset(href: string) {
    const col = {
      type: "Collection",
      stac_version: "1.1.0",
      id: "non-s3",
      links: [
        { rel: "item", href: `${CAT2}/x/0.json` },
        { rel: "item", href: `${CAT2}/x/1.json` },
      ],
    };
    const map: Record<string, unknown> = {
      [`${CAT2}/collection.json`]: col,
      [`${CAT2}/x/0.json`]: {
        type: "Feature",
        assets: { data: { href, type: "application/vnd.apache.parquet" } },
      },
    };
    return resolveStacManifest(col, `${CAT2}/collection.json`, {
      fetchText: async (u: string) =>
        JSON.stringify(
          map[u] ??
            (() => {
              throw new Error("404");
            })()
        ),
    });
  }

  it("emits a directory glob for an Azure Blob collection — its container LISTS", async () => {
    // Azure enumeration reads the https URL as written (no s3:// conversion),
    // so the entity keeps the account host the egress allowlist derives from.
    const m = await resolveWithAsset(
      "https://acct.blob.core.windows.net/data/type=x/part-0.parquet"
    );
    expect(m.entities.map((e) => e.url)).toEqual([
      "https://acct.blob.core.windows.net/data/type=x/*.parquet",
    ]);
  });

  it("SKIPS a multi-file collection on a host with no listing rather than truncating it", async () => {
    // A plain web host answers no listing, so the other files are unreachable.
    // Emitting the ONE known file would answer confidently from partial data —
    // the failure mode worse than no entity at all.
    const m = await resolveWithAsset("https://files.example.org/data/part-0.parquet");
    expect(m.entities).toEqual([]);
  });
});
