import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/export/[id] — the persisted entry as one self-contained .html
 * download. A missing ENTRY is a 404; a missing export BUNDLE (ENOENT from
 * the assembler) is a 503 with the build hint; success returns text/html
 * with the download headers.
 */
const loadHistoryEntry = vi.fn();
const exportDashboardHtml = vi.fn();
vi.mock("@/lib/history/storage", () => ({
  loadHistoryEntry: (...a: unknown[]) => loadHistoryEntry(...a),
}));
vi.mock("@/lib/export/html-export", () => ({
  exportDashboardHtml: (...a: unknown[]) => exportDashboardHtml(...a),
  exportFilename: () => "dashboard.html",
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { GET } from "@/app/api/export/[id]/route";

const call = (id: string) => GET(new Request("http://x"), { params: Promise.resolve({ id }) });
const entry = { spec: { root: {} }, meta: { question: "q", timestamp: Date.now() } };

beforeEach(() => vi.clearAllMocks());

describe("GET /api/export/[id]", () => {
  it("404s when the history entry is missing", async () => {
    loadHistoryEntry.mockRejectedValue(new Error("ENOENT"));
    const res = await call("h1");
    expect(res.status).toBe(404);
  });

  it("503s with the build hint when export bundles are missing", async () => {
    loadHistoryEntry.mockResolvedValue(entry);
    exportDashboardHtml.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const res = await call("h1");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("mcp:build-viewer");
  });

  it("returns the html attachment on success", async () => {
    loadHistoryEntry.mockResolvedValue(entry);
    exportDashboardHtml.mockResolvedValue({
      html: "<html></html>",
      report: { bundle: "b", bytes: 10 },
    });
    const res = await call("h1");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Content-Disposition")).toContain("dashboard.html");
    expect(await res.text()).toBe("<html></html>");
  });
});
