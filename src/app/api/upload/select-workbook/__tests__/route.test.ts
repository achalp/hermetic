import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/upload/select-workbook — ingest all sheets of a stored workbook.
 * Gates: missing excel_id (400), expired workbook / missing buffer (404),
 * no valid sheets (400). Success stores each sheet, records the manifest,
 * warms a sandbox, and returns the primary sheet's { csv_id, schema }.
 */
const getExcelBuffer = vi.fn();
const getStoredExcel = vi.fn();
const parseExcelMeta = vi.fn();
const sheetToCSV = vi.fn();
const detectRelationships = vi.fn();
const storeCSV = vi.fn();
const storeWorkbookManifest = vi.fn();
const prepareWarmSandbox = vi.fn();
vi.mock("uuid", () => {
  let n = 0;
  return { v4: () => `csv-${++n}` };
});
vi.mock("@/lib/excel/storage", () => ({
  getExcelBuffer: (...a: unknown[]) => getExcelBuffer(...a),
  getStoredExcel: (...a: unknown[]) => getStoredExcel(...a),
}));
vi.mock("@/lib/excel/parser", () => ({
  parseExcelMeta: (...a: unknown[]) => parseExcelMeta(...a),
  sheetToCSV: (...a: unknown[]) => sheetToCSV(...a),
}));
vi.mock("@/lib/excel/relationships", () => ({
  detectRelationships: (...a: unknown[]) => detectRelationships(...a),
}));
vi.mock("@/lib/csv/parser", () => ({
  parseCSV: () => ({ headers: ["a"], rowCount: 1 }),
  toCSVText: () => "a\n1",
}));
vi.mock("@/lib/csv/schema", () => ({
  extractSchema: () => ({ row_count: 1, columns: [{ name: "a" }] }),
}));
vi.mock("@/lib/csv/storage", () => ({
  storeCSV: (...a: unknown[]) => storeCSV(...a),
  storeWorkbookManifest: (...a: unknown[]) => storeWorkbookManifest(...a),
}));
vi.mock("@/lib/llm/prompts", () => ({ sanitizeSheetName: (s: string) => s }));
vi.mock("@/lib/sandbox", () => ({
  prepareWarmSandbox: (...a: unknown[]) => prepareWarmSandbox(...a),
}));
vi.mock("@/lib/runtime-config", () => ({ getActiveSandboxRuntime: () => "docker" }));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { POST } from "@/app/api/upload/select-workbook/route";

const req = (b: unknown) =>
  new Request("http://x/api/upload/select-workbook", { method: "POST", body: JSON.stringify(b) });

beforeEach(() => {
  vi.clearAllMocks();
  getStoredExcel.mockReturnValue({ filename: "wb.xlsx" });
  getExcelBuffer.mockResolvedValue(Buffer.from("x"));
  parseExcelMeta.mockResolvedValue({ sheets: [{ name: "S1" }, { name: "S2" }], workbook: {} });
  detectRelationships.mockReturnValue([]);
  sheetToCSV.mockReturnValue("a\n1");
  storeCSV.mockResolvedValue(undefined);
});

describe("POST /api/upload/select-workbook", () => {
  it("400s without an excel_id", async () => {
    expect((await POST(req({}))).status).toBe(400);
  });

  it("404s when the workbook has expired", async () => {
    getStoredExcel.mockReturnValue(null);
    expect((await POST(req({ excel_id: "gone" }))).status).toBe(404);
  });

  it("400s when no valid sheets are found", async () => {
    sheetToCSV.mockImplementation(() => {
      throw new Error("empty");
    });
    const res = await POST(req({ excel_id: "e1" }));
    expect(res.status).toBe(400);
  });

  it("stores all sheets, records the manifest, and returns the primary sheet", async () => {
    const res = await POST(req({ excel_id: "e1" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.csv_id).toBe("csv-1");
    expect(body.schema).toBeDefined();
    expect(storeCSV).toHaveBeenCalledTimes(2); // two sheets
    expect(storeWorkbookManifest).toHaveBeenCalled();
    expect(prepareWarmSandbox).toHaveBeenCalled();
  });
});
