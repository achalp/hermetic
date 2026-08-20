import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /api/audit — on-demand non-blind audit. POST { history_id } runs the audit
 * (400 on a bad id, 502 when it returns nothing); GET ?history_id reads the
 * persisted one (null when absent, never a throw).
 */
const loadHistoryAudit = vi.fn();
const auditHistoryEntry = vi.fn();
vi.mock("@/lib/history/storage", () => ({
  loadHistoryAudit: (...a: unknown[]) => loadHistoryAudit(...a),
}));
vi.mock("@/lib/pipeline/audit", () => ({
  auditHistoryEntry: (...a: unknown[]) => auditHistoryEntry(...a),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { POST, GET } from "@/app/api/audit/route";

const validId = "abcdef01-2345-6789-abcd";
const post = (b: unknown) =>
  POST(new Request("http://x/api/audit", { method: "POST", body: JSON.stringify(b) }));
const get = (qs: string) => GET(new Request(`http://x/api/audit${qs}`));

beforeEach(() => vi.clearAllMocks());

describe("POST /api/audit", () => {
  it("400s on a missing/invalid history_id", async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ history_id: "no" })).status).toBe(400);
  });

  it("runs the audit and returns its result", async () => {
    auditHistoryEntry.mockResolvedValue({ verdict: "sound" });
    const res = await post({ history_id: validId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ audit: { verdict: "sound" } });
  });

  it("502s when the audit yields nothing", async () => {
    auditHistoryEntry.mockResolvedValue(null);
    expect((await post({ history_id: validId })).status).toBe(502);
  });
});

describe("GET /api/audit", () => {
  it("400s without a valid history_id", async () => {
    expect((await get("")).status).toBe(400);
  });

  it("returns the persisted audit", async () => {
    loadHistoryAudit.mockResolvedValue({ verdict: "sound" });
    const res = await get(`?history_id=${validId}`);
    expect(res.status).toBe(200);
    expect((await res.json()).audit).toEqual({ verdict: "sound" });
  });

  it("returns null when reading the audit throws", async () => {
    loadHistoryAudit.mockRejectedValue(new Error("no file"));
    const res = await get(`?history_id=${validId}`);
    expect(res.status).toBe(200);
    expect((await res.json()).audit).toBeNull();
  });
});
