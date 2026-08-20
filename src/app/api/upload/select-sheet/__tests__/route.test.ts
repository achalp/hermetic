import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/upload/select-sheet — extract one chosen sheet of a stored
 * workbook. Gates: missing excel_id/sheet_name (400), expired workbook (404),
 * missing buffer (404), an IngestError → 400. Success returns { csv_id, schema }.
 */
const getExcelBuffer = vi.fn();
const getStoredExcel = vi.fn();
const ingestFile = vi.fn();
vi.mock("@/lib/excel/storage", () => ({
  getExcelBuffer: (...a: unknown[]) => getExcelBuffer(...a),
  getStoredExcel: (...a: unknown[]) => getStoredExcel(...a),
}));
vi.mock("@/lib/sources/ingest", async () => {
  class IngestError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  return { ingestFile: (...a: unknown[]) => ingestFile(...a), IngestError };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { POST } from "@/app/api/upload/select-sheet/route";
import { IngestError } from "@/lib/sources/ingest";

const req = (b: unknown) =>
  new Request("http://x/api/upload/select-sheet", { method: "POST", body: JSON.stringify(b) });

beforeEach(() => {
  vi.clearAllMocks();
  getStoredExcel.mockReturnValue({ filename: "wb.xlsx" });
  getExcelBuffer.mockResolvedValue(Buffer.from("x"));
});

describe("POST /api/upload/select-sheet", () => {
  it("400s without excel_id/sheet_name", async () => {
    expect((await POST(req({ excel_id: "e1" }))).status).toBe(400);
  });

  it("404s when the workbook has expired", async () => {
    getStoredExcel.mockReturnValue(null);
    expect((await POST(req({ excel_id: "gone", sheet_name: "S1" }))).status).toBe(404);
  });

  it("404s when the buffer is missing", async () => {
    getExcelBuffer.mockResolvedValue(null);
    expect((await POST(req({ excel_id: "e1", sheet_name: "S1" }))).status).toBe(404);
  });

  it("400s and maps an IngestError message", async () => {
    ingestFile.mockRejectedValue(new IngestError("empty_columns", "x"));
    const res = await POST(req({ excel_id: "e1", sheet_name: "S1" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Selected sheet has no columns");
  });

  it("returns csv_id + schema on success", async () => {
    ingestFile.mockResolvedValue({ kind: "dataset", csvId: "csv-1", schema: { columns: [] } });
    const res = await POST(req({ excel_id: "e1", sheet_name: "S1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ csv_id: "csv-1", schema: { columns: [] } });
  });
});
