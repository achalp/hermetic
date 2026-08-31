import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The shared multi-entity question module (spec §7) — ONE resolver + ONE
 * context builder used by BOTH pipelines, so ask and investigate cannot drift
 * (author directive: "the two must stay at par").
 *
 * Trust property under test: the request carries ids, never data — every id is
 * re-validated against the server's own manifest store and csv storage.
 */

const storeGet = vi.fn();
vi.mock("@/lib/manifest/store", () => ({
  getManifestStore: () => ({ get: (id: string) => storeGet(id) }),
}));
const getStoredCSV = vi.fn();
vi.mock("@/lib/csv/storage", () => ({
  getStoredCSV: (id: string) => getStoredCSV(id),
}));

import {
  resolveManifestQuestion,
  buildManifestQuestionContext,
} from "@/lib/manifest/question-context";

const HOST = "https://acct.blob.core.windows.net";

function seed() {
  const record = {
    manifestId: "m1",
    entities: new Map([
      [
        "housing-gap",
        {
          entity: { name: "housing-gap", url: `${HOST}/data/housing-gap.parquet` },
          status: "ready",
          csvId: "c-gap",
        },
      ],
      [
        "geographies",
        {
          entity: { name: "geographies", url: `${HOST}/data/geographies.parquet` },
          status: "ready",
          csvId: "c-geo",
        },
      ],
    ]),
  };
  storeGet.mockImplementation((id: string) => (id === "m1" ? record : undefined));
  const stored = (name: string, extra: Record<string, unknown> = {}) => ({
    remoteParquetUrl: `${HOST}/data/${name}.parquet`,
    schema: {
      csv_id: `c-${name}`,
      filename: name,
      row_count: 1000,
      columns: [
        {
          name: "geography_id",
          dtype: "string",
          null_count: 0,
          meta: { kind: "categorical" },
          sample_values: ["01001", "01003"],
        },
        {
          name: "year",
          dtype: "number",
          null_count: 0,
          meta: { kind: "number", min: 2010, max: 2024 },
        },
      ],
      sample_rows: [{ geography_id: "01001", year: 2020 }],
    },
    ...extra,
  });
  getStoredCSV.mockImplementation((id: string) =>
    id === "c-gap" ? stored("housing-gap") : id === "c-geo" ? stored("geographies") : undefined
  );
}

const REQ = {
  manifest_id: "m1",
  entities: [
    { name: "housing-gap", csv_id: "c-gap" },
    { name: "geographies", csv_id: "c-geo" },
  ],
};

beforeEach(() => {
  storeGet.mockReset();
  getStoredCSV.mockReset();
  seed();
});

describe("resolveManifestQuestion — ids re-validated server-side", () => {
  it("resolves a valid request, primary first", () => {
    const r = resolveManifestQuestion(REQ, "c-gap");
    expect(r.entities.map((e) => e.name)).toEqual(["housing-gap", "geographies"]);
    expect(r.entities[0]!.stored.remoteParquetUrl).toContain("housing-gap.parquet");
  });

  it("rejects an unknown manifest / unknown entity", () => {
    expect(() => resolveManifestQuestion({ ...REQ, manifest_id: "nope" }, "c-gap")).toThrow(
      /Unknown manifest/
    );
    expect(() =>
      resolveManifestQuestion(
        { ...REQ, entities: [{ name: "not-real", csv_id: "c-gap" }] },
        "c-gap"
      )
    ).toThrow(/Unknown manifest entity/);
  });

  it("rejects a csvId that is not the server's OWN registration for that entity", () => {
    // A forged or stale id: the client cannot bind entity names to arbitrary
    // sources — only to what the server itself registered.
    expect(() =>
      resolveManifestQuestion(
        { ...REQ, entities: [{ name: "housing-gap", csv_id: "c-geo" }] },
        "c-geo"
      )
    ).toThrow(/out of date/);
  });

  it("rejects when the primary does not match the request's csv_id", () => {
    // The pipeline's plumbing (egress grant, wasm input.csv) hangs off csv_id;
    // a disagreeing primary would ship entity A's context with entity B's data.
    expect(() => resolveManifestQuestion(REQ, "c-geo")).toThrow(/primary entity must match/);
  });

  it("rejects an entity whose stored source has vanished (restart)", () => {
    getStoredCSV.mockReturnValue(undefined);
    expect(() => resolveManifestQuestion(REQ, "c-gap")).toThrow(/no longer loaded/);
  });
});

describe("buildManifestQuestionContext — the prompt section", () => {
  it("docker: per-entity read expressions, schemas in metadata mode", () => {
    const r = resolveManifestQuestion(REQ, "c-gap");
    const ctx = buildManifestQuestionContext(r, { kind: "docker" });
    expect(ctx).toContain(`read_parquet('${HOST}/data/housing-gap.parquet')`);
    expect(ctx).toContain(`read_parquet('${HOST}/data/geographies.parquet')`);
    expect(ctx).toContain("### Entity: housing-gap (1,000 rows)");
    expect(ctx).toContain("geography_id"); // schema lines rendered
    // No delivered-file paths on docker — the code reads the URLs.
    expect(ctx).not.toContain("/data/entities/");
  });

  it("wasm: delivered CSV paths, no URLs — the worker has no network", () => {
    const r = resolveManifestQuestion(REQ, "c-gap");
    const ctx = buildManifestQuestionContext(r, {
      kind: "wasm",
      paths: new Map([
        ["housing-gap", "/data/input.csv"],
        ["geographies", "/data/entities/geographies.csv"],
      ]),
    });
    expect(ctx).toContain('pd.read_csv("/data/input.csv")');
    expect(ctx).toContain('pd.read_csv("/data/entities/geographies.csv")');
    expect(ctx).not.toContain("read_parquet");
    expect(ctx).not.toContain(HOST);
  });

  it("surfaces JOIN hints when entities share key columns", () => {
    const r = resolveManifestQuestion(REQ, "c-gap");
    const ctx = buildManifestQuestionContext(r, { kind: "docker" });
    // Both fixtures carry geography_id with overlapping sample values — the
    // relationship detector should hand the model the join key.
    expect(ctx).toContain("Detected relationships");
    expect(ctx).toContain("geography_id");
  });
});
