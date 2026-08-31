import { describe, it, expect } from "vitest";
import { parseDatasetManifest, parseDatasetManifestText } from "@/lib/manifest/parse";
import { adaptFilesArray } from "@/lib/manifest/adapters";
import { ManifestError, MAX_MANIFEST_ENTITIES, MAX_DESCRIPTION_CHARS } from "@/lib/manifest/shared";

/**
 * The v1 adapter matrix (spec §2/§4). Fixtures are shaped after the LIVE
 * examples the research verified: the housing manifest (files-array family),
 * a Frictionless datapackage, and a HuggingFace-shaped Croissant document.
 */

const M_URL = "https://ahihubpublic.blob.core.windows.net/data/manifest.json";

// ── files-array (the housing manifest's family) ──────────────────────────────

const HOUSING = {
  runId: "r1",
  license: "CC-BY-4.0",
  files: [
    {
      name: "housing-landscape.parquet",
      url: "https://ahihubpublic.blob.core.windows.net/data/housing-landscape.parquet",
      contentType: "application/octet-stream",
      description: "Occupied units by AMI band.",
      rows: 953550,
      bytes: 31882021,
      sha256: "a".repeat(64),
      yearsCovered: [2010, 2024],
    },
    {
      name: "dictionary/housing-landscape.json",
      url: "https://ahihubpublic.blob.core.windows.net/data/dictionary/housing-landscape.json",
      contentType: "application/json",
      description: "Machine-readable data dictionary.",
      rows: null,
      bytes: 2200814,
    },
    {
      name: "LICENSE.md",
      url: "https://ahihubpublic.blob.core.windows.net/data/LICENSE.md",
      contentType: "text/markdown",
    },
  ],
};

describe("files-array adapter (housing / OpenAlex family)", () => {
  it("harvests parquet entries and skips dictionaries/markdown as metadata, not errors", () => {
    const m = parseDatasetManifest(HOUSING, M_URL);
    expect(m.format).toBe("files-array");
    expect(m.entities).toHaveLength(1);
    expect(m.entities[0]!.name).toBe("housing-landscape");
    expect(m.entities[0]!.url).toContain("housing-landscape.parquet");
  });

  it("maps rows/bytes/sha256 into hints and folds yearsCovered into the description", () => {
    const e = parseDatasetManifest(HOUSING, M_URL).entities[0]!;
    expect(e.rowCountHint).toBe(953550);
    expect(e.bytesHint).toBe(31882021);
    expect(e.sha256).toBe("a".repeat(64));
    // The selection pre-step reads descriptions — the year span belongs there.
    expect(e.description).toContain("2010–2024");
  });

  it("carries the manifest-level license through", () => {
    expect(parseDatasetManifest(HOUSING, M_URL).license).toBe("CC-BY-4.0");
  });

  it("resolves RELATIVE paths against the manifest URL (same-host by construction)", () => {
    const m = adaptFilesArray(
      { files: [{ name: "x.parquet", path: "sub/x.parquet" }] },
      "https://host.example.com/data/manifest.json"
    );
    expect(m!.entities[0]!.url).toBe("https://host.example.com/data/sub/x.parquet");
  });

  it("accepts a TOP-LEVEL array manifest", () => {
    const m = parseDatasetManifest(
      [{ name: "a.parquet", url: "https://h/x/a.parquet" }],
      "https://h/m.json"
    );
    expect(m.entities).toHaveLength(1);
  });

  it("keeps glob entries — a hive tree is a legitimate entity", () => {
    const m = parseDatasetManifest(
      { files: [{ name: "buildings", url: "https://h/release/theme=buildings/*.parquet" }] },
      "https://h/m.json"
    );
    expect(m.entities[0]!.url).toContain("*");
  });
});

// ── datapackage ──────────────────────────────────────────────────────────────

const DATAPACKAGE = {
  name: "housing-pack",
  title: "Housing indicators",
  description: "A pack of housing tables.",
  licenses: [{ name: "ODC-BY-1.0" }],
  resources: [
    {
      name: "landscape",
      path: "tables/landscape.parquet",
      format: "parquet",
      bytes: 1000,
      hash: "sha256:" + "b".repeat(64),
      schema: {
        fields: [
          { name: "geography_id", type: "string", description: "FIPS code as string." },
          { name: "year", type: "integer" },
        ],
      },
    },
    { name: "readme", path: "README.md", format: "md" },
    { name: "sharded", path: ["a.parquet", "b.parquet"] },
  ],
};

describe("datapackage adapter", () => {
  it("harvests parquet resources with Table Schema column docs", () => {
    const m = parseDatasetManifest(DATAPACKAGE, "https://host.example.com/pkg/datapackage.json");
    expect(m.format).toBe("datapackage");
    expect(m.title).toBe("Housing indicators");
    expect(m.license).toBe("ODC-BY-1.0");
    expect(m.entities).toHaveLength(1);
    const e = m.entities[0]!;
    expect(e.url).toBe("https://host.example.com/pkg/tables/landscape.parquet");
    expect(e.sha256).toBe("b".repeat(64));
    // Only the field WITH a description becomes a doc — a nameless doc is noise.
    expect(e.columnDocs).toEqual([{ name: "geography_id", description: "FIPS code as string." }]);
  });

  it("skips multi-path resources rather than merging shards into a wrong entity", () => {
    const m = parseDatasetManifest(DATAPACKAGE, "https://host.example.com/pkg/datapackage.json");
    expect(m.entities.some((e) => e.name === "sharded")).toBe(false);
  });

  it("WINS over the files-array adapter when both shapes match (fixed order)", () => {
    // `resources` is also a files-array key; the more specific standard must win,
    // or a datapackage would lose its column docs to the generic scan.
    const m = parseDatasetManifest(DATAPACKAGE, "https://host.example.com/pkg/datapackage.json");
    expect(m.format).toBe("datapackage");
  });
});

// ── croissant ────────────────────────────────────────────────────────────────

const CROISSANT = {
  "@context": { "@vocab": "https://schema.org/" },
  "@type": "sc:Dataset",
  name: "hf-style-dataset",
  description: "A dataset published with Croissant metadata.",
  license: "apache-2.0",
  distribution: [
    {
      "@type": "cr:FileObject",
      "@id": "repo",
      name: "repo",
      contentUrl: "https://host.example.com/datasets/x",
      encodingFormat: "git+https",
    },
    {
      "@type": "cr:FileObject",
      "@id": "data.parquet",
      name: "data",
      contentUrl: "https://host.example.com/datasets/x/data.parquet",
      encodingFormat: "application/x-parquet",
      contentSize: 4096,
    },
  ],
  recordSet: [
    {
      "@type": "cr:RecordSet",
      name: "default",
      field: [{ name: "text", description: "The document body." }],
    },
  ],
};

describe("croissant adapter", () => {
  it("harvests parquet FileObjects and attaches recordSet docs in the unambiguous case", () => {
    const m = parseDatasetManifest(CROISSANT, "https://host.example.com/croissant.json");
    expect(m.format).toBe("croissant");
    expect(m.entities).toHaveLength(1);
    expect(m.entities[0]!.url).toContain("data.parquet");
    expect(m.entities[0]!.bytesHint).toBe(4096);
    expect(m.entities[0]!.columnDocs).toEqual([
      { name: "text", description: "The document body." },
    ]);
  });

  it("maps a simple FileSet glob under containedIn to a glob entity", () => {
    const m = parseDatasetManifest(
      {
        "@context": "https://schema.org/",
        "@type": "Dataset",
        distribution: [
          {
            "@type": "cr:FileObject",
            "@id": "dir",
            contentUrl: "https://host.example.com/data/",
            encodingFormat: "inode/directory",
          },
          {
            "@type": "cr:FileSet",
            name: "parts",
            containedIn: { "@id": "dir" },
            includes: "*.parquet",
            encodingFormat: "application/x-parquet",
          },
        ],
      },
      "https://host.example.com/croissant.json"
    );
    expect(m.entities[0]!.url).toBe("https://host.example.com/data/*.parquet");
  });

  it("does NOT attach recordSet docs when several entities make the mapping ambiguous", () => {
    const two = {
      ...CROISSANT,
      distribution: [
        ...CROISSANT.distribution,
        {
          "@type": "cr:FileObject",
          "@id": "more.parquet",
          contentUrl: "https://host.example.com/datasets/x/more.parquet",
          encodingFormat: "application/x-parquet",
        },
      ],
    };
    const m = parseDatasetManifest(two, "https://host.example.com/croissant.json");
    expect(m.entities).toHaveLength(2);
    // A wrong column doc is worse than none.
    expect(m.entities.every((e) => e.columnDocs === undefined)).toBe(true);
  });
});

// ── shared behavior: caps, clamps, collisions, rejection ─────────────────────

describe("shared adapter behavior", () => {
  it("fails LOUDLY over the entity cap instead of truncating silently", () => {
    const files = Array.from({ length: MAX_MANIFEST_ENTITIES + 1 }, (_, i) => ({
      name: `e${i}.parquet`,
      url: `https://h/data/e${i}.parquet`,
    }));
    expect(() => parseDatasetManifest({ files }, "https://h/m.json")).toThrow(/more than the 200/);
  });

  it("suffixes name collisions — selection is by name, a merge reads wrong data", () => {
    const m = parseDatasetManifest(
      {
        files: [
          { name: "sales.parquet", url: "https://h/2023/sales.parquet" },
          { name: "sales.parquet", url: "https://h/2024/sales.parquet" },
        ],
      },
      "https://h/m.json"
    );
    expect(m.entities.map((e) => e.name)).toEqual(["sales", "sales-2"]);
  });

  it("clamps hostile descriptions and strips control characters (prompt surface)", () => {
    const hostile = "evil" + String.fromCharCode(0, 7) + "y".repeat(2 * MAX_DESCRIPTION_CHARS);
    const m = parseDatasetManifest(
      { files: [{ name: "x.parquet", url: "https://h/x.parquet", description: hostile }] },
      "https://h/m.json"
    );
    const d = m.entities[0]!.description!;
    expect(d.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
    expect(d).not.toContain(String.fromCharCode(0));
    expect(d).not.toContain(String.fromCharCode(7));
    // The control chars are REMOVED, not replaced — "evil" joins straight to "y".
    expect(d.startsWith("evily")).toBe(true);
  });

  it("rejects unrecognized JSON with a message naming the supported forms", () => {
    for (const junk of [
      {},
      { hello: 1 },
      42,
      null,
      "nope",
      { files: [{ name: "a.csv", url: "https://h/a.csv" }] },
    ]) {
      expect(() => parseDatasetManifest(junk, "https://h/m.json")).toThrow(ManifestError);
      expect(() => parseDatasetManifest(junk, "https://h/m.json")).toThrow(/Supported:/);
    }
  });

  it("parseDatasetManifestText: strips a BOM, and names invalid JSON specifically", () => {
    const text = "﻿" + JSON.stringify(HOUSING);
    expect(parseDatasetManifestText(text, M_URL).entities).toHaveLength(1);
    expect(() => parseDatasetManifestText("<html>403</html>", M_URL)).toThrow(/valid JSON/);
  });

  it("hint coercion never lets NaN or negatives through", () => {
    const m = parseDatasetManifest(
      {
        files: [{ name: "x.parquet", url: "https://h/x.parquet", rows: "banana", bytes: -5 }],
      },
      "https://h/m.json"
    );
    expect(m.entities[0]!.rowCountHint).toBeUndefined();
    expect(m.entities[0]!.bytesHint).toBeUndefined();
  });
});
