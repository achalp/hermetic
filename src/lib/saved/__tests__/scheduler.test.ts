/**
 * Scheduler tests — timer-driven background code that fails silently in
 * production (nobody is watching a cron re-run). Previously 0% covered;
 * only the schedule STORAGE had tests.
 *
 * Fake timers drive the tick loop; the pipeline/storage/fs are mocked at
 * their module boundaries, mirroring the orchestrator-test recipe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/saved/schedule-storage", () => ({
  loadSchedules: vi.fn(async () => []),
  recordRunOutcome: vi.fn(async () => {}),
  findDueSchedules: vi.fn(async () => []),
  findFileWatchSchedules: vi.fn(async () => []),
}));
vi.mock("@/lib/saved/storage", () => ({ loadSavedVisualization: vi.fn() }));
vi.mock("@/lib/pipeline/orchestrator", () => ({ runPipelineWithCode: vi.fn() }));
vi.mock("@/lib/runtime-config", () => ({ getActiveSandboxRuntime: vi.fn(() => "docker") }));
vi.mock("fs/promises", () => ({
  mkdir: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {}),
}));

import {
  runScheduleNow,
  ensureSchedulerStarted,
  __stopSchedulerForTesting,
} from "@/lib/saved/scheduler";
import {
  findDueSchedules,
  recordRunOutcome,
  type ScheduleEntry,
} from "@/lib/saved/schedule-storage";
import { loadSavedVisualization } from "@/lib/saved/storage";
import { runPipelineWithCode } from "@/lib/pipeline/orchestrator";
import { writeFile } from "fs/promises";

const mockedDue = vi.mocked(findDueSchedules);
const mockedOutcome = vi.mocked(recordRunOutcome);
const mockedLoad = vi.mocked(loadSavedVisualization);
const mockedRun = vi.mocked(runPipelineWithCode);
const mockedWrite = vi.mocked(writeFile);

const entry = (over: Partial<ScheduleEntry> = {}): ScheduleEntry =>
  ({ vizId: "viz-1", cadence: "daily", autoExport: [], ...over }) as unknown as ScheduleEntry;

const okResult = (rows = 2) => ({
  executionResult: {
    success: true as const,
    results: {},
    chart_data: {},
    images: {},
    datasets: { main: Array.from({ length: rows }, (_, i) => ({ n: i })) },
    execution_ms: 5,
  },
  generatedCode: "code",
  question: "q",
});

beforeEach(() => {
  vi.clearAllMocks();
  mockedLoad.mockResolvedValue({
    generatedCode: "code",
    csvContent: "a\n1\n",
    meta: { question: "q" },
  } as never);
  mockedRun.mockResolvedValue(okResult() as never);
});

afterEach(async () => {
  await __stopSchedulerForTesting();
  vi.useRealTimers();
});

describe("runScheduleNow", () => {
  it("re-runs the saved code headlessly and records success", async () => {
    const out = await runScheduleNow(entry());
    expect(out.ok).toBe(true);
    expect(mockedRun).toHaveBeenCalledWith("code", "a\n1\n", "q", {
      runtime: "docker",
      csvId: "viz-1",
    });
    expect(mockedOutcome).toHaveBeenCalledWith("viz-1", { status: "success" });
  });

  it("records an error outcome (with the message) when the pipeline fails", async () => {
    mockedRun.mockRejectedValue(new Error("sandbox exploded"));
    const out = await runScheduleNow(entry());
    expect(out).toEqual({ ok: false, error: "sandbox exploded" });
    expect(mockedOutcome).toHaveBeenCalledWith("viz-1", {
      status: "error",
      error: "sandbox exploded",
    });
  });

  it("writes a CSV auto-export with quoting, without failing the run on export error", async () => {
    mockedRun.mockResolvedValue(okResult() as never);
    mockedLoad.mockResolvedValue({
      generatedCode: "code",
      csvContent: "a\n1\n",
      meta: { question: "q" },
    } as never);
    // Comma-bearing COLUMN NAME + quote-bearing value → both must be quoted
    // (the pre-consolidation local serializer joined headers unquoted).
    mockedRun.mockResolvedValue({
      ...okResult(),
      executionResult: {
        ...okResult().executionResult,
        datasets: { main: [{ "name, legal": 'Acme, "Inc"', v: 1 }] },
      },
    } as never);
    const out = await runScheduleNow(entry({ autoExport: ["csv"] as never }));
    expect(out.ok).toBe(true);
    const csv = mockedWrite.mock.calls.find(([p]) => String(p).endsWith(".csv"))?.[1] as string;
    expect(csv).toBe('"name, legal",v\n"Acme, ""Inc""",1\n');

    // Export failure must not fail the run.
    mockedWrite.mockRejectedValueOnce(new Error("disk full"));
    const out2 = await runScheduleNow(entry({ autoExport: ["csv"] as never }));
    expect(out2.ok).toBe(true);
    expect(mockedOutcome).toHaveBeenLastCalledWith("viz-1", { status: "success" });
  });
});

describe("tick loop", () => {
  it("runs due schedules sequentially on the 60s tick and is idempotent to start", async () => {
    vi.useFakeTimers();
    await ensureSchedulerStarted();
    await ensureSchedulerStarted(); // idempotent — no second interval

    mockedDue.mockResolvedValue([entry({ vizId: "a" }), entry({ vizId: "b" })] as never);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockedOutcome.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);

    // Next tick with nothing due runs nothing new.
    mockedDue.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockedOutcome).toHaveBeenCalledTimes(2);
  });

  it("a failing tick never kills the loop (next tick still fires)", async () => {
    vi.useFakeTimers();
    await ensureSchedulerStarted();
    mockedDue.mockRejectedValueOnce(new Error("storage unreadable"));
    await vi.advanceTimersByTimeAsync(60_000); // absorbed
    mockedDue.mockResolvedValue([entry({ vizId: "later" })] as never);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockedOutcome).toHaveBeenCalledWith("later", { status: "success" });
  });
});
