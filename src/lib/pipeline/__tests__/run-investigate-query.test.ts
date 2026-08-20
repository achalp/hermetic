/**
 * End-to-end harness for the Investigate god-orchestrator `runInvestigateQuery`.
 * Mirrors the sibling Ask harness (run-ask-query-happy.test.ts): every external
 * boundary is mocked at its module edge — CSV storage, the planner, the
 * multi-wave orchestrator, the dashboard/step composers — so the test drives
 * the REAL orchestration body through the real `runPatchStream` (run context,
 * cost, diagnostics wired exactly as the route wires them):
 *   load/resolve source → plan → emit __plan/__cells → run investigation →
 *   build trace → cache artifacts → merge findings/products → generative
 *   compose → finalize/emit spec lines → grounding/verifiability epilogue.
 *
 * We deliberately keep every step's `series` and declared `findings` EMPTY so
 * `compiledMode` stays false and the run takes the GENERATIVE compose path
 * (composeInvestigation), which is the cheaper branch to stand up.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Boundary mocks (hoisted) ──────────────────────────────────────────
vi.mock("@/lib/csv/storage", () => ({
  getStoredCSV: vi.fn(),
  getCSVContent: vi.fn(async () => "region,revenue\nWest,10\n"),
  getGeoJSONContent: vi.fn(async () => null),
  getWorkbookManifest: vi.fn(() => undefined),
  isLocalFile: vi.fn(() => false),
  isRemoteFile: vi.fn(() => false),
}));
vi.mock("@/lib/llm/investigate-planner", () => ({
  generatePlan: vi.fn(),
}));
vi.mock("@/lib/pipeline/investigate-orchestrator", () => ({
  runInvestigation: vi.fn(),
  deriveAnalysisWindow: vi.fn(() => undefined),
}));
vi.mock("@/lib/llm/investigate-composer", () => ({
  composeInvestigation: vi.fn(),
  gapCheckComposer: vi.fn(),
}));
vi.mock("@/lib/llm/step-cell-composer", () => ({
  composeStepCell: vi.fn(async () => null),
}));
vi.mock("@/lib/pipeline/dashboard-compose", () => ({
  composeAndStreamDashboard: vi.fn(async (a: { emit: (s: string) => void }) => {
    a.emit(JSON.stringify({ op: "add", path: "/root", value: "root" }) + "\n");
  }),
  buildValuesSection: vi.fn(() => ""),
}));

import { setPathRoots } from "@/lib/paths";
import { runPatchStream } from "@/lib/pipeline/patch-stream";
import { runInvestigateQuery } from "@/lib/pipeline/run-investigate-query";
import { getStoredCSV } from "@/lib/csv/storage";
import { generatePlan } from "@/lib/llm/investigate-planner";
import { runInvestigation } from "@/lib/pipeline/investigate-orchestrator";
import { composeInvestigation } from "@/lib/llm/investigate-composer";
import { parsePatchLines } from "@/lib/pipeline/patch-lines";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import type { SubQuestionResult } from "@/lib/contracts/investigation";

const mockedGetStored = vi.mocked(getStoredCSV);
const mockedPlan = vi.mocked(generatePlan);
const mockedRunInvestigation = vi.mocked(runInvestigation);
const mockedCompose = vi.mocked(composeInvestigation);

const schema: CSVSchema = {
  csv_id: "csv-1",
  filename: "sales.csv",
  row_count: 100,
  columns: [
    { name: "region", dtype: "string", sample_values: ["West"] },
    { name: "revenue", dtype: "number", sample_values: ["10"] },
  ],
  sample_rows: [],
  detected_domain: "general",
  source_type: "file",
} as unknown as CSVSchema;

/** A minimal-but-valid successful sub-question result. `series`/`findings`
 * stay empty so the generative compose path is taken. */
function subResult(over: Partial<SubQuestionResult> = {}): SubQuestionResult {
  return {
    index: 0,
    question: "q1",
    rationale: "r1",
    depends_on: [],
    startedAt: 1,
    finishedAt: 2,
    result: {
      generatedCode: "print('v1')",
      question: "q1",
      executionResult: {
        success: true,
        results: { total: 42 },
        chart_data: { bars: [{ x: "West", y: 10 }] },
        images: {},
        datasets: { main: [{ region: "West", revenue: 10 }] },
        execution_ms: 7,
        series: [],
        values: [],
        regimes: {},
        findings: [],
      },
    },
    ...over,
  } as SubQuestionResult;
}

/** A generative-compose mock: yields a single valid /root spec-patch line. */
function composeOutput() {
  return {
    initialState: {
      results: { step_1_total: 42 },
      chart_data: { step_1_bars: [{ x: "West", y: 10 }] },
      investigation: { approach: "a", steps: [] },
    },
    textStream: (async function* () {
      yield JSON.stringify({ op: "add", path: "/root", value: "root" }) + "\n";
    })(),
  } as unknown as ReturnType<typeof composeInvestigation>;
}

let dir: string;
beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), "investigate-"));
  setPathRoots({ dataRoot: dir, scratchRoot: join(dir, "scratch"), userRoot: join(dir, "user") });
  mockedGetStored.mockReturnValue({ schema } as never);
  mockedPlan.mockResolvedValue({
    ok: true,
    plan: {
      approach: "Break the question into revenue drivers.",
      subQuestions: [{ question: "q1", rationale: "r1", depends_on: [] }],
    },
  } as never);
  mockedRunInvestigation.mockImplementation(async (_subQs, opts) => {
    const sub = subResult();
    opts.onProgress?.({ kind: "plan_ready", total: 1, approach: "a" });
    opts.onProgress?.({ kind: "sub_started", index: 0, total: 1, question: "q1" });
    opts.onProgress?.({
      kind: "sub_finished",
      index: 0,
      total: 1,
      question: "q1",
      stepResult: sub,
    });
    opts.onProgress?.({ kind: "all_done", total: 1 });
    return [sub];
  });
  mockedCompose.mockReturnValue(composeOutput());
});
afterEach(() => {
  setPathRoots({});
  rmSync(dir, { recursive: true, force: true });
});

function baseArgs(over: Record<string, unknown> = {}) {
  return {
    context: {} as never,
    question: "What drives revenue?",
    source: { kind: "csv" as const, csvId: "csv-1" },
    codeGenModel: "m-code",
    uiComposeModel: "m-ui",
    sandboxRuntime: "docker" as const,
    runState: { csvId: "csv-1", question: "What drives revenue?" },
    ...over,
  };
}

async function drive(over: Record<string, unknown> = {}) {
  const lines: string[] = [];
  const runId = await runPatchStream(
    "test:investigate",
    { write: (d) => lines.push(d) },
    async (stream) => {
      await runInvestigateQuery({ ...baseArgs(over), stream } as never);
    }
  );
  return { runId, lines, patches: parsePatchLines(lines) };
}

describe("runInvestigateQuery — CSV generative happy path", () => {
  it("plans, runs the investigation, composes, and streams the spec", async () => {
    const { runId, patches } = await drive();

    expect(typeof runId).toBe("string");
    expect(mockedPlan).toHaveBeenCalledTimes(1);
    expect(mockedRunInvestigation).toHaveBeenCalledTimes(1);
    expect(mockedCompose).toHaveBeenCalledTimes(1);

    // The plan is surfaced to the client immediately.
    const planPatch = patches.find((p) => p.path === "/state/__plan");
    expect(planPatch).toBeDefined();
    expect((planPatch!.value as { approach: string }).approach).toContain("revenue drivers");
    // __cells container is opened for the notebook view.
    expect(patches.some((p) => p.path === "/state/__cells")).toBe(true);
    // The onProgress handler flips the step's status through running → done.
    expect(
      patches.some((p) => p.path === "/state/__plan/steps/0/status" && p.value === "running")
    ).toBe(true);
    expect(
      patches.some((p) => p.path === "/state/__plan/steps/0/status" && p.value === "done")
    ).toBe(true);
    // Merged data injected into spec state before the composed spec streams.
    expect(patches.some((p) => p.path === "/state/__results")).toBe(true);
    expect(patches.some((p) => p.path === "/state/__chart_data")).toBe(true);
    // The composed spec came through.
    expect(patches.some((p) => p.path === "/root")).toBe(true);
    // Verifiability / purpose epilogue emitted (grounding pass ran).
    expect(patches.some((p) => p.path === "/state/__verifiability")).toBe(true);
    expect(patches.some((p) => p.path === "/state/__purpose")).toBe(true);
  });

  it("surfaces a data-quality banner when a step degraded", async () => {
    mockedRunInvestigation.mockImplementation(async (_subQs, opts) => {
      const sub = subResult({ degraded: true, degradedReason: "all zeros" });
      opts.onProgress?.({
        kind: "sub_degraded",
        index: 0,
        total: 1,
        question: "q1",
        degradedReason: "all zeros",
        stepResult: sub,
      });
      return [sub];
    });

    const { patches } = await drive();

    expect(mockedCompose).toHaveBeenCalledTimes(1);
    const dq = patches.find((p) => p.path === "/state/__dataQuality");
    expect(dq).toBeDefined();
    expect((dq!.value as { degraded: unknown[] }).degraded).toHaveLength(1);
    // Degraded step's status is streamed live onto the plan.
    expect(
      patches.some((p) => p.path === "/state/__plan/steps/0/status" && p.value === "degraded")
    ).toBe(true);
  });
});

describe("runInvestigateQuery — failure paths", () => {
  it("emits __error when plan generation fails (no compose)", async () => {
    mockedPlan.mockResolvedValue({ ok: false, error: "planner exploded" } as never);

    const { patches } = await drive();

    expect(mockedRunInvestigation).not.toHaveBeenCalled();
    expect(mockedCompose).not.toHaveBeenCalled();
    const err = patches.find((p) => p.path === "/state/__error");
    expect(err).toBeDefined();
    expect(String(err!.value)).toContain("planner exploded");
  });

  it("emits __error when the CSV cannot be resolved", async () => {
    mockedGetStored.mockReturnValue(undefined as never);

    const { patches } = await drive();

    expect(mockedPlan).not.toHaveBeenCalled();
    const err = patches.find((p) => p.path === "/state/__error");
    expect(err).toBeDefined();
    expect(String(err!.value)).toContain("CSV not found");
  });
});
