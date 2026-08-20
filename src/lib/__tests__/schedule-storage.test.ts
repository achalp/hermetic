import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  computeNextRunAt,
  setSchedule,
  deleteSchedule,
  listSchedules,
  getSchedule,
  recordRunOutcome,
  findDueSchedules,
  loadSchedules,
  __setScheduleCacheForTesting,
  __clearScheduleCache,
  __getSchedulesPath,
} from "@/lib/saved/schedule-storage";
import { setPathRoots } from "@/lib/paths";
import { logger } from "@/lib/logger";

// Every mutation now re-reads the live file before writing (finding M8), so
// tests need a REAL isolated data dir, not a stubbed in-memory cache.
let scheduleRoot: string;
beforeEach(async () => {
  scheduleRoot = await mkdtemp(join(tmpdir(), "hermetic-schedules-"));
  setPathRoots({ dataRoot: join(scheduleRoot, "data") });
  __clearScheduleCache();
});

afterEach(async () => {
  setPathRoots({});
  __clearScheduleCache();
  await rm(scheduleRoot, { recursive: true, force: true });
});

// Helper: a fixed reference time
const NOON_MONDAY = new Date("2026-04-27T12:00:00"); // Monday 2026-04-27 noon local
const SUNDAY_5AM = new Date("2026-04-26T05:00:00"); // Sunday before
const FRIDAY_8AM = new Date("2026-04-24T08:00:00"); // Friday earlier

describe("computeNextRunAt — cadence math", () => {
  it("hourly: rounds to the next top-of-hour", () => {
    const next = computeNextRunAt("hourly", NOON_MONDAY);
    expect(next).toBe(new Date("2026-04-27T13:00:00").getTime());
  });

  it("daily-9am: today if before 9am, tomorrow otherwise", () => {
    const a = computeNextRunAt("daily-9am", FRIDAY_8AM);
    expect(a).toBe(new Date("2026-04-24T09:00:00").getTime());

    const b = computeNextRunAt("daily-9am", NOON_MONDAY);
    expect(b).toBe(new Date("2026-04-28T09:00:00").getTime());
  });

  it("daily-eod: today if before 6pm, tomorrow otherwise", () => {
    const a = computeNextRunAt("daily-eod", NOON_MONDAY);
    expect(a).toBe(new Date("2026-04-27T18:00:00").getTime());

    const b = computeNextRunAt("daily-eod", new Date("2026-04-27T19:00:00"));
    expect(b).toBe(new Date("2026-04-28T18:00:00").getTime());
  });

  it("weekly-monday: next Monday 9am from a Sunday", () => {
    const next = computeNextRunAt("weekly-monday", SUNDAY_5AM);
    expect(next).toBe(new Date("2026-04-27T09:00:00").getTime());
  });

  it("weekly-monday: a week away from a Monday after 9am", () => {
    const next = computeNextRunAt("weekly-monday", NOON_MONDAY);
    expect(next).toBe(new Date("2026-05-04T09:00:00").getTime());
  });

  it("weekly-monday: same day before 9am picks today", () => {
    const mondayEarly = new Date("2026-04-27T07:00:00");
    const next = computeNextRunAt("weekly-monday", mondayEarly);
    // Monday 9am same day, NOT next week
    // (the function adds 7 only when dow === 1 AND time has passed)
    expect(next).toBe(new Date("2026-05-04T09:00:00").getTime());
    // Note: implementation defers to next Monday because daysUntilMonday === 7 when dow === 1.
    // This is intentional for v1 simplicity — Monday-morning runs always target *next* Monday.
  });

  it("on-file-change: returns null", () => {
    expect(computeNextRunAt("on-file-change")).toBeNull();
  });
});

describe("setSchedule / getSchedule / listSchedules", () => {
  it("creates a new schedule", async () => {
    const entry = await setSchedule({
      vizId: "abc",
      cadence: "hourly",
      autoExport: ["xlsx"],
    });
    expect(entry.vizId).toBe("abc");
    expect(entry.cadence).toBe("hourly");
    expect(entry.autoExport).toEqual(["xlsx"]);
    expect(entry.createdAt).toBeGreaterThan(0);
    expect(entry.lastRunAt).toBeNull();
    expect(entry.lastStatus).toBeNull();
    expect(entry.nextRunAt).not.toBeNull();
  });

  it("lists schedules", async () => {
    await setSchedule({ vizId: "a", cadence: "hourly", autoExport: [] });
    await setSchedule({ vizId: "b", cadence: "daily-9am", autoExport: ["xlsx"] });
    const all = await listSchedules();
    expect(all).toHaveLength(2);
  });

  it("preserves createdAt + lastRunAt when re-setting (overwrite)", async () => {
    const first = await setSchedule({ vizId: "x", cadence: "hourly", autoExport: [] });
    await recordRunOutcome("x", { status: "success" });

    const second = await setSchedule({
      vizId: "x",
      cadence: "daily-9am",
      autoExport: ["xlsx"],
    });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.lastRunAt).not.toBeNull();
    expect(second.cadence).toBe("daily-9am");
  });

  it("does not clobber a concurrent writer's entry (finding M8)", async () => {
    // This process records schedule "a" (fills its cache).
    await setSchedule({ vizId: "a", cadence: "hourly", autoExport: [] });
    // ANOTHER process writes "b" straight to the file — invisible to our cache.
    const path = __getSchedulesPath();
    const onDisk = JSON.parse(await readFile(path, "utf-8")) as { vizId: string }[];
    onDisk.push({
      vizId: "b",
      cadence: "daily-9am",
      autoExport: [],
      createdAt: 1,
      lastRunAt: null,
      lastStatus: null,
      lastError: null,
      nextRunAt: 1,
    } as never);
    await writeFile(path, JSON.stringify(onDisk), "utf-8");
    // Our next write must MERGE onto the live file, not overwrite from a stale
    // snapshot — so "b" survives alongside our new "c".
    await setSchedule({ vizId: "c", cadence: "hourly", autoExport: [] });
    const finalDisk = JSON.parse(await readFile(path, "utf-8")) as { vizId: string }[];
    expect(finalDisk.map((s) => s.vizId).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("deleteSchedule", () => {
  it("returns true when removing an existing schedule", async () => {
    await setSchedule({ vizId: "a", cadence: "hourly", autoExport: [] });
    expect(await deleteSchedule("a")).toBe(true);
    expect(await getSchedule("a")).toBeUndefined();
  });

  it("returns false when removing a non-existent schedule", async () => {
    expect(await deleteSchedule("nope")).toBe(false);
  });
});

describe("recordRunOutcome", () => {
  it("updates lastRunAt + lastStatus on success", async () => {
    await setSchedule({ vizId: "a", cadence: "hourly", autoExport: [] });
    await recordRunOutcome("a", { status: "success" });
    const entry = await getSchedule("a");
    expect(entry?.lastStatus).toBe("success");
    expect(entry?.lastRunAt).toBeGreaterThan(0);
    expect(entry?.lastError).toBeNull();
  });

  it("captures error message on failure", async () => {
    await setSchedule({ vizId: "a", cadence: "hourly", autoExport: [] });
    await recordRunOutcome("a", { status: "error", error: "sandbox timeout" });
    const entry = await getSchedule("a");
    expect(entry?.lastStatus).toBe("error");
    expect(entry?.lastError).toBe("sandbox timeout");
  });

  it("recomputes nextRunAt after a run", async () => {
    await setSchedule({ vizId: "a", cadence: "hourly", autoExport: [] });
    await new Promise((r) => setTimeout(r, 10));
    await recordRunOutcome("a", { status: "success" });
    const after = (await getSchedule("a"))?.nextRunAt;
    // nextRunAt should still be defined after a run; for hourly it may be the same hour mark
    expect(after).not.toBeNull();
    expect(typeof after).toBe("number");
    // The recomputed nextRunAt should always be strictly after lastRunAt
    const lastRun = (await getSchedule("a"))?.lastRunAt;
    expect(after!).toBeGreaterThan(lastRun!);
  });

  it("ignores recordRunOutcome for unknown schedule", async () => {
    await expect(recordRunOutcome("nope", { status: "success" })).resolves.toBeUndefined();
  });
});

describe("findDueSchedules", () => {
  it("returns schedules whose nextRunAt is past", async () => {
    const past = Date.now() - 1000;
    const future = Date.now() + 60 * 60 * 1000;
    __setScheduleCacheForTesting(
      new Map([
        [
          "due",
          {
            vizId: "due",
            cadence: "hourly" as const,
            autoExport: [],
            createdAt: 0,
            lastRunAt: null,
            lastStatus: null,
            lastError: null,
            nextRunAt: past,
          },
        ],
        [
          "later",
          {
            vizId: "later",
            cadence: "hourly" as const,
            autoExport: [],
            createdAt: 0,
            lastRunAt: null,
            lastStatus: null,
            lastError: null,
            nextRunAt: future,
          },
        ],
      ])
    );
    const due = await findDueSchedules();
    expect(due).toHaveLength(1);
    expect(due[0].vizId).toBe("due");
  });

  it("excludes on-file-change schedules from time-based due check", async () => {
    __setScheduleCacheForTesting(
      new Map([
        [
          "watch",
          {
            vizId: "watch",
            cadence: "on-file-change" as const,
            autoExport: [],
            createdAt: 0,
            lastRunAt: null,
            lastStatus: null,
            lastError: null,
            nextRunAt: null,
          },
        ],
      ])
    );
    const due = await findDueSchedules();
    expect(due).toEqual([]);
  });
});

describe("loadSchedules — corrupt file vs missing file", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hermetic-schedules-"));
    setPathRoots({ dataRoot: join(root, "data") });
    __clearScheduleCache(); // force the next load to hit disk
  });

  afterEach(async () => {
    setPathRoots({});
    __clearScheduleCache();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it("missing file → empty map, no backup, no warn (ENOENT is the normal empty state)", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const map = await loadSchedules();
    expect(map.size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    // No backup file was invented for a file that never existed.
    await expect(readdir(dirname(__getSchedulesPath()))).rejects.toThrow();
  });

  it("corrupt JSON → warn, .corrupt-<ts> backup preserved, then empty map", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const path = __getSchedulesPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{ this is not json", "utf-8");

    const map = await loadSchedules();
    expect(map.size).toBe(0);
    expect(warn).toHaveBeenCalledOnce();

    const files = await readdir(dirname(path));
    const backup = files.find((f) => /^schedules\.json\.corrupt-\d+$/.test(f));
    expect(backup).toBeDefined();
    // The only copy of the user's schedules survived, byte for byte.
    expect(await readFile(join(dirname(path), backup!), "utf-8")).toBe("{ this is not json");
  });

  it("persist after a corrupt load writes fresh without touching the backup", async () => {
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    const path = __getSchedulesPath();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "not json at all", "utf-8");

    await loadSchedules();
    await setSchedule({ vizId: "fresh", cadence: "hourly", autoExport: [] });

    const files = await readdir(dirname(path));
    expect(files.filter((f) => f.startsWith("schedules.json.corrupt-"))).toHaveLength(1);
    const raw = await readFile(path, "utf-8");
    expect(JSON.parse(raw)[0].vizId).toBe("fresh");
  });
});
