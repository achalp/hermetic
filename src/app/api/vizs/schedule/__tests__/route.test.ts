import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * /api/vizs/schedule — schedule CRUD for saved vizs. GET lists (starting the
 * scheduler); POST creates/replaces (400 without vizId or an invalid cadence);
 * DELETE removes (400 without vizId).
 */
const setSchedule = vi.fn();
const deleteSchedule = vi.fn();
const listSchedules = vi.fn();
const ensureSchedulerStarted = vi.fn();
vi.mock("@/lib/saved/schedule-storage", () => ({
  setSchedule: (...a: unknown[]) => setSchedule(...a),
  deleteSchedule: (...a: unknown[]) => deleteSchedule(...a),
  listSchedules: (...a: unknown[]) => listSchedules(...a),
}));
vi.mock("@/lib/saved/scheduler", () => ({
  ensureSchedulerStarted: (...a: unknown[]) => ensureSchedulerStarted(...a),
}));
vi.mock("@/lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  serializeError: (e: unknown) => ({ error: String(e) }),
}));

import { GET, POST, DELETE } from "@/app/api/vizs/schedule/route";

const mk = (method: string, b: unknown) =>
  new Request("http://x/api/vizs/schedule", { method, body: JSON.stringify(b) });

beforeEach(() => {
  vi.clearAllMocks();
  ensureSchedulerStarted.mockResolvedValue(undefined);
});

describe("GET /api/vizs/schedule", () => {
  it("starts the scheduler and lists schedules", async () => {
    listSchedules.mockResolvedValue([{ vizId: "v1", cadence: "daily-9am" }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).schedules).toHaveLength(1);
    expect(ensureSchedulerStarted).toHaveBeenCalled();
  });
});

describe("POST /api/vizs/schedule", () => {
  it("400s without a vizId", async () => {
    expect((await POST(mk("POST", { cadence: "hourly" }))).status).toBe(400);
  });

  it("400s on an invalid cadence", async () => {
    expect((await POST(mk("POST", { vizId: "v1", cadence: "every-second" }))).status).toBe(400);
  });

  it("creates a schedule and filters invalid export formats", async () => {
    setSchedule.mockResolvedValue({ vizId: "v1", cadence: "daily-9am", autoExport: ["csv"] });
    const res = await POST(
      mk("POST", { vizId: "v1", cadence: "daily-9am", autoExport: ["csv", "pdf"] })
    );
    expect(res.status).toBe(200);
    expect(setSchedule).toHaveBeenCalledWith({
      vizId: "v1",
      cadence: "daily-9am",
      autoExport: ["csv"],
    });
    expect((await res.json()).ok).toBe(true);
  });
});

describe("DELETE /api/vizs/schedule", () => {
  it("400s without a vizId", async () => {
    expect((await DELETE(mk("DELETE", {}))).status).toBe(400);
  });

  it("removes the schedule", async () => {
    deleteSchedule.mockResolvedValue(true);
    const res = await DELETE(mk("DELETE", { vizId: "v1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true });
  });
});
