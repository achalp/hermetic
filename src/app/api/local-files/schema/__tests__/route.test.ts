import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/local-files/schema — the local-file ingest surface. Behind the
 * origin gate (403) + root-jail (403), extension allowlist (400 for files),
 * then delegates to the shared ingest pipeline. Success returns either a
 * dataset ({ csv_id, schema }) or a sheet-picker payload; an IngestError → 400.
 */
const validateLocalOrigin = vi.fn();
const isAllowedExtension = vi.fn();
const isPathAllowed = vi.fn();
const ingestFile = vi.fn();
const stat = vi.fn();
vi.mock("node:fs/promises", () => ({ stat: (...a: unknown[]) => stat(...a) }));
vi.mock("@/lib/local-files/security", () => ({
  validateLocalOrigin: (...a: unknown[]) => validateLocalOrigin(...a),
  isAllowedExtension: (...a: unknown[]) => isAllowedExtension(...a),
  isPathAllowed: (...a: unknown[]) => isPathAllowed(...a),
  PATH_NOT_ALLOWED_ERROR: "path not allowed",
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

import { POST } from "@/app/api/local-files/schema/route";
import { IngestError } from "@/lib/sources/ingest";

const req = (b: unknown) =>
  new Request("http://localhost/api/local-files/schema", {
    method: "POST",
    body: JSON.stringify(b),
  });

beforeEach(() => {
  vi.clearAllMocks();
  validateLocalOrigin.mockReturnValue(true);
  isPathAllowed.mockReturnValue(true);
  isAllowedExtension.mockReturnValue(true);
  stat.mockResolvedValue({ isDirectory: () => false, isFile: () => true });
});

describe("POST /api/local-files/schema", () => {
  it("403s off-origin", async () => {
    validateLocalOrigin.mockReturnValue(false);
    expect((await POST(req({ path: "/data/a.csv", type: "file" }))).status).toBe(403);
  });

  it("403s a path outside the root-jail", async () => {
    isPathAllowed.mockReturnValue(false);
    expect((await POST(req({ path: "/etc/passwd", type: "file" }))).status).toBe(403);
  });

  it("400s a disallowed file extension", async () => {
    isAllowedExtension.mockReturnValue(false);
    const res = await POST(req({ path: "/data/a.exe", type: "file" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not supported");
  });

  it("returns csv_id + schema for a single dataset", async () => {
    ingestFile.mockResolvedValue({ kind: "dataset", csvId: "csv-1", schema: { columns: [] } });
    const res = await POST(req({ path: "/data/a.csv", type: "file" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ csv_id: "csv-1", schema: { columns: [] } });
  });

  it("returns a sheet-picker payload for a multi-sheet workbook", async () => {
    ingestFile.mockResolvedValue({
      kind: "sheet_picker",
      excelId: "e1",
      sheets: [{ name: "S1" }],
      filename: "wb.xlsx",
      relationships: [],
    });
    const res = await POST(req({ path: "/data/wb.xlsx", type: "file" }));
    expect(res.status).toBe(200);
    expect((await res.json()).excel_id).toBe("e1");
  });

  it("400s and maps an IngestError", async () => {
    ingestFile.mockRejectedValue(new IngestError("empty_rows", "x"));
    const res = await POST(req({ path: "/data/a.csv", type: "file" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("no data rows");
  });
});
