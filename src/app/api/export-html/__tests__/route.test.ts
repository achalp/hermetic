import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Contract tests for /api/export-html. Focus: the route's own obligations —
 * shallow shape validation (400 on garbage, but tolerant of `__`-prefixed
 * state, which is stripped by the assembler, not here), the download response
 * shape (text/html attachment + report headers), and the actionable 503 when
 * the viewer export bundles were never built. The assembler itself is
 * exercised in src/lib/export/__tests__/html-export.test.ts, so it is mocked.
 */

vi.mock("@/lib/export/html-export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/export/html-export")>();
  // exportFilename stays real — the Content-Disposition filename derivation
  // is part of the contract under test.
  return { ...actual, exportDashboardHtml: vi.fn() };
});
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { POST } from "@/app/api/export-html/route";
import { exportDashboardHtml } from "@/lib/export/html-export";

const mockExport = vi.mocked(exportDashboardHtml);

const req = (body: unknown) =>
  new Request("http://t/api/export-html", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const validSpec = {
  root: "r",
  elements: { r: { type: "BarChart", props: {}, children: [] } },
  state: { datasets: { main: [{ a: 1 }] }, __cost: { usd: 1 } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockExport.mockResolvedValue({
    html: "<!doctype html><html>ok</html>",
    report: { bundle: "standard", bytes: 1234567, elementCount: 3, fullOnlyTypesUsed: [] },
  });
});

describe("POST /api/export-html", () => {
  it("rejects an unreadable body with 400", async () => {
    const res = await POST(req("not-json{"));
    expect(res.status).toBe(400);
  });

  it("rejects a body without a spec.elements record with 400", async () => {
    for (const bad of [
      { question: "no spec at all" },
      { spec: { root: "r" } }, // elements missing
      { spec: { root: "r", elements: "nope" } }, // elements not a record
      { spec: { root: "r", elements: {}, state: 42 } }, // state not a record
    ]) {
      const res = await POST(req(bad));
      expect(res.status).toBe(400);
      expect(mockExport).not.toHaveBeenCalled();
    }
  });

  it("returns the file as a text/html attachment with the report in headers", async () => {
    const res = await POST(
      req({ spec: validSpec, question: "Revenue by region?", created_at: "2026-08-05T00:00:00Z" })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="revenue-by-region.html"'
    );
    expect(res.headers.get("X-Hermetic-Export-Bundle")).toBe("standard");
    expect(res.headers.get("X-Hermetic-Export-Bytes")).toBe("1234567");
    expect(res.headers.get("X-Hermetic-Export-Elements")).toBe("3");
    expect(await res.text()).toBe("<!doctype html><html>ok</html>");
  });

  it("passes the spec through AS-IS (incl. __ state) and resolves distDir from cwd", async () => {
    await POST(req({ spec: validSpec, question: "q" }));

    expect(mockExport).toHaveBeenCalledTimes(1);
    const input = mockExport.mock.calls[0][0];
    // The route must not strip internal state — that's the assembler's job.
    expect(input.spec.state).toHaveProperty("__cost");
    expect(input.distDir.endsWith("src/mcp/viewer/dist")).toBe(true);
  });

  it("names the full-only culprits in a header when the full bundle is used", async () => {
    mockExport.mockResolvedValue({
      html: "<!doctype html>",
      report: { bundle: "full", bytes: 9, elementCount: 1, fullOnlyTypesUsed: ["Globe3D"] },
    });
    const res = await POST(req({ spec: validSpec }));
    expect(res.headers.get("X-Hermetic-Export-Bundle")).toBe("full");
    expect(res.headers.get("X-Hermetic-Export-Full-Only")).toBe("Globe3D");
  });

  it("maps a missing viewer build (ENOENT) to an actionable 503", async () => {
    const enoent = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    mockExport.mockRejectedValue(enoent);

    const res = await POST(req({ spec: validSpec }));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error).toContain("pnpm mcp:build-viewer");
  });

  it("maps other assembler failures to the standard error shape", async () => {
    mockExport.mockRejectedValue(new Error("boom"));
    const res = await POST(req({ spec: validSpec }));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("boom");
  });
});
