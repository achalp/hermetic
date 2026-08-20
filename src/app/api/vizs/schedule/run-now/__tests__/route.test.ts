import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * POST /api/vizs/schedule/run-now — trigger a registered schedule immediately.
 * 400 without a vizId, 404 when no schedule is registered, otherwise returns
 * the run result.
 */
const getSchedule = vi.fn();
const runScheduleNow = vi.fn();
vi.mock("@/lib/saved/schedule-storage", () => ({
  getSchedule: (...a: unknown[]) => getSchedule(...a),
}));
vi.mock("@/lib/saved/scheduler", () => ({
  runScheduleNow: (...a: unknown[]) => runScheduleNow(...a),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { POST } from "@/app/api/vizs/schedule/run-now/route";

const req = (b: unknown) => new Request("http://x", { method: "POST", body: JSON.stringify(b) });

beforeEach(() => vi.clearAllMocks());

describe("POST /api/vizs/schedule/run-now", () => {
  it("400s without a vizId", async () => {
    expect((await POST(req({}))).status).toBe(400);
  });

  it("404s when no schedule is registered", async () => {
    getSchedule.mockResolvedValue(null);
    expect((await POST(req({ vizId: "v1" }))).status).toBe(404);
  });

  it("runs the schedule and returns the result", async () => {
    getSchedule.mockResolvedValue({ vizId: "v1" });
    runScheduleNow.mockResolvedValue({ ok: true, historyId: "h1" });
    const res = await POST(req({ vizId: "v1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, historyId: "h1" });
  });
});
