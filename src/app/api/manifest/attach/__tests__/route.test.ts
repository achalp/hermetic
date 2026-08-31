import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `/api/manifest/attach` — the lazy-extraction report-back (spec §5.5). The
 * trust property under test: the body names IDS, never data, and a csvId only
 * attaches when the server's own record of it points at EXACTLY this entity's
 * normalized URL. A client cannot bind an entity name to some other source.
 */

vi.mock("@/lib/local-files/security", () => ({ validateLocalOrigin: () => true }));

const getStoredCSV = vi.fn<(id: string) => unknown>();
vi.mock("@/lib/csv/storage", () => ({
  getStoredCSV: (id: string) => getStoredCSV(id),
}));

import { POST } from "../route";
import { getManifestStore } from "@/lib/manifest/store";

const MANIFEST_ID = "6f000000-0000-4000-8000-000000000001";
const CSV_ID = "6f000000-0000-4000-8000-000000000002";
const ENTITY_URL = "https://acct.blob.core.windows.net/data/housing.parquet";

function seedRecord() {
  getManifestStore().put({
    manifestId: MANIFEST_ID,
    manifest: {
      manifestUrl: "https://acct.blob.core.windows.net/data/manifest.json",
      format: "files-array",
      entities: [{ name: "housing", url: ENTITY_URL }],
    },
    excluded: [],
    entities: new Map([
      ["housing", { entity: { name: "housing", url: ENTITY_URL }, status: "pending" as const }],
    ]),
    manifestHash: "h",
    connectedAt: 0,
  });
}

const STORED = {
  remoteParquetUrl: ENTITY_URL,
  schema: {
    csv_id: CSV_ID,
    filename: "housing",
    row_count: 7,
    columns: [{ name: "x" }],
    sample_rows: [],
  },
};

function post(body: unknown): Request {
  return new Request("http://localhost/api/manifest/attach", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getStoredCSV.mockReset();
  seedRecord();
});

describe("POST /api/manifest/attach", () => {
  it("attaches a csvId whose stored URL matches the entity, and marks it ready", async () => {
    getStoredCSV.mockReturnValue(STORED);
    const res = await POST(post({ manifestId: MANIFEST_ID, name: "housing", csvId: CSV_ID }));
    expect(res.status).toBe(200);
    const detail = (await res.json()) as { status: string; csvId: string };
    expect(detail.status).toBe("ready");
    expect(detail.csvId).toBe(CSV_ID);
    expect(getManifestStore().get(MANIFEST_ID)!.entities.get("housing")).toMatchObject({
      status: "ready",
      rowCount: 7,
      columnCount: 1,
    });
  });

  it("REFUSES a csvId that points at a different source (409, nothing mutated)", async () => {
    getStoredCSV.mockReturnValue({
      ...STORED,
      remoteParquetUrl: "https://acct.blob.core.windows.net/data/other.parquet",
    });
    const res = await POST(post({ manifestId: MANIFEST_ID, name: "housing", csvId: CSV_ID }));
    expect(res.status).toBe(409);
    expect(getManifestStore().get(MANIFEST_ID)!.entities.get("housing")!.status).toBe("pending");
  });

  it("404s an unknown csvId, manifest, or entity", async () => {
    getStoredCSV.mockReturnValue(undefined);
    expect(
      (await POST(post({ manifestId: MANIFEST_ID, name: "housing", csvId: CSV_ID }))).status
    ).toBe(404);
    getStoredCSV.mockReturnValue(STORED);
    expect((await POST(post({ manifestId: CSV_ID, name: "housing", csvId: CSV_ID }))).status).toBe(
      404
    );
    expect(
      (await POST(post({ manifestId: MANIFEST_ID, name: "nope", csvId: CSV_ID }))).status
    ).toBe(404);
  });

  it("400s a malformed body before touching the store", async () => {
    expect((await POST(post({ manifestId: "not-a-uuid", name: "x", csvId: CSV_ID }))).status).toBe(
      400
    );
  });
});
