/**
 * Contract tests for the /api/upload POST handler — the ingestion entry
 * point, previously 0% covered. Same recipe as the query-route tests: heavy
 * transitive imports are mocked so importing the route is side-effect-free;
 * these pin the validation branches AND the happy paths' response shapes
 * (real CSV/GeoJSON parsing runs — it's pure).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/csv/storage", () => ({
  storeCSV: vi.fn(async () => {}),
  storeGeoJSON: vi.fn(async () => {}),
  storeLocalFileRef: vi.fn(),
}));
vi.mock("@/lib/excel/storage", () => ({ storeExcel: vi.fn(async () => {}) }));
vi.mock("@/lib/sandbox", () => ({ prepareWarmSandbox: vi.fn() }));
vi.mock("@/lib/runtime-config", () => ({ getActiveSandboxRuntime: vi.fn(() => "docker") }));
vi.mock("@/lib/parquet/materialize", () => ({ materializeCsvToParquet: vi.fn() }));
// Excel parsing pulls exceljs — stub it; the Excel paths get their own tests
// with fixture workbooks if ever needed.
vi.mock("@/lib/excel/parser", () => ({
  parseExcelMeta: vi.fn(async () => ({ sheets: [], workbook: {} })),
  sheetToCSV: vi.fn(),
}));
vi.mock("@/lib/excel/relationships", () => ({ detectRelationships: vi.fn(() => []) }));
// Shrink the size cap so the oversize branch is testable without a huge blob
// (Object.defineProperty on File doesn't survive the FormData round-trip).
vi.mock("@/lib/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/constants")>();
  return { ...actual, MAX_CSV_SIZE_BYTES: 4096, MAX_CSV_SIZE_LABEL: "4 KB" };
});

import { POST } from "@/app/api/upload/route";
import { storeCSV, storeGeoJSON } from "@/lib/csv/storage";

function upload(name: string, content: string): Request {
  const form = new FormData();
  form.set("csv", new File([content], name));
  return new Request("http://localhost/api/upload", { method: "POST", body: form });
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/upload — validation contract", () => {
  it("400s when no file is provided", async () => {
    const form = new FormData();
    const res = await POST(
      new Request("http://localhost/api/upload", { method: "POST", body: form })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/No file/);
  });

  it("400s on an unsupported extension", async () => {
    const res = await POST(upload("malware.exe", "x"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/\.csv, \.xlsx/);
  });

  it("400s on an oversized file with the limit in the message", async () => {
    // Cap mocked to 4 KB above; this body exceeds it.
    const res = await POST(upload("big.csv", "a,b\n" + "1,2\n".repeat(2000)));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/too large.*4 KB/i);
  });

  it("400s on a CSV with no data rows", async () => {
    const res = await POST(upload("empty.csv", "a,b\n"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/no data rows/i);
  });

  it("400s on a .json file that is not GeoJSON", async () => {
    const res = await POST(upload("data.json", JSON.stringify({ hello: 1 })));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not valid GeoJSON/);
  });
});

describe("POST /api/upload — happy paths", () => {
  it("stores a valid CSV and returns csv_id + extracted schema", async () => {
    const res = await POST(upload("sales.csv", "region,revenue\nWest,100\nEast,200\n"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.csv_id).toMatch(/[0-9a-f-]{36}/);
    expect(body.schema.row_count).toBe(2);
    expect(body.schema.columns.map((c: { name: string }) => c.name)).toEqual(["region", "revenue"]);
    expect(storeCSV).toHaveBeenCalledTimes(1);
  });

  it("detects GeoJSON in a .json file, stores the sidecar, and flags the schema", async () => {
    const geojson = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "SF", pop: 800000 },
          geometry: { type: "Point", coordinates: [-122.4, 37.77] },
        },
      ],
    });
    const res = await POST(upload("cities.json", geojson));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schema.has_geojson).toBe(true);
    expect(storeGeoJSON).toHaveBeenCalledTimes(1);
  });
});
