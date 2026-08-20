/**
 * Happy-path harness for the Ask pipeline `runAskQuery`. Every external
 * boundary is mocked at its module edge — CSV storage, the code-gen/exec
 * pipeline (orchestrator), and the dashboard composer — so the test drives the
 * real orchestration body: load source → run pipeline → declared-findings
 * merge/validate/lint → cache artifacts → append conversation turn → compose.
 * Runs through the real runPatchStream so run context, cost, and diagnostics
 * are wired exactly as the route wires them.
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
vi.mock("@/lib/pipeline/orchestrator", () => ({
  runPipeline: vi.fn(),
  runPipelineWithCode: vi.fn(),
}));
vi.mock("@/lib/pipeline/dashboard-compose", () => ({
  composeAndStreamDashboard: vi.fn(async (a: { emit: (s: string) => void }) => {
    a.emit(JSON.stringify({ op: "add", path: "/root", value: "root" }) + "\n");
  }),
}));

import { setPathRoots } from "@/lib/paths";
import { runPatchStream } from "@/lib/pipeline/patch-stream";
import { runAskQuery } from "@/lib/pipeline/run-ask-query";
import { runPipeline, runPipelineWithCode } from "@/lib/pipeline/orchestrator";
import { getStoredCSV } from "@/lib/csv/storage";
import { composeAndStreamDashboard } from "@/lib/pipeline/dashboard-compose";
import { parsePatchLines } from "@/lib/pipeline/patch-lines";
import type { CSVSchema } from "@/lib/contracts/data-schema";

const mockedRunPipeline = vi.mocked(runPipeline);
const mockedRunWithCode = vi.mocked(runPipelineWithCode);
const mockedGetStored = vi.mocked(getStoredCSV);
const mockedCompose = vi.mocked(composeAndStreamDashboard);

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

function execResult() {
  return {
    success: true as const,
    results: { total: 42 },
    chart_data: { bars: [{ x: "West", y: 10 }] },
    datasets: { main: [{ region: "West", revenue: 10 }] },
    images: {},
    findings: [] as unknown[],
    execution_ms: 7,
  };
}

let dir: string;
beforeEach(() => {
  vi.clearAllMocks();
  dir = mkdtempSync(join(tmpdir(), "ask-happy-"));
  setPathRoots({ dataRoot: dir, scratchRoot: join(dir, "scratch"), userRoot: join(dir, "user") });
  mockedGetStored.mockReturnValue({ schema } as never);
  mockedRunPipeline.mockResolvedValue({
    generatedCode: "print('v1')",
    executionResult: execResult(),
  } as never);
  mockedRunWithCode.mockResolvedValue({
    generatedCode: "edited",
    executionResult: execResult(),
  } as never);
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

describe("runAskQuery — CSV happy path", () => {
  it("runs the pipeline, caches artifacts, and composes the dashboard", async () => {
    const lines: string[] = [];
    const runId = await runPatchStream(
      "test:ask",
      { write: (d) => lines.push(d) },
      async (stream) => {
        await runAskQuery({ ...baseArgs(), stream } as never);
      }
    );
    expect(typeof runId).toBe("string");
    expect(mockedRunPipeline).toHaveBeenCalledTimes(1);
    expect(mockedCompose).toHaveBeenCalledTimes(1);
    // The composer received the execution result + the stored schema.
    const composeArg = mockedCompose.mock.calls[0][0];
    expect(composeArg.opts.schema).toBe(schema);
    expect(composeArg.opts.question).toBe("What drives revenue?");
    // A patch stream came out, including the composer's /root add.
    const patches = parsePatchLines(lines);
    expect(patches.some((p) => p.path === "/root")).toBe(true);
  });

  it("skips code-gen and runs the edited code path when context.code is supplied", async () => {
    await runPatchStream("test:ask", { write: () => {} }, async (stream) => {
      await runAskQuery({
        ...baseArgs({ context: { code: "df.head()" } }),
        stream,
      } as never);
    });
    expect(mockedRunWithCode).toHaveBeenCalledTimes(1);
    expect(mockedRunPipeline).not.toHaveBeenCalled();
    expect(mockedCompose).toHaveBeenCalledTimes(1);
  });

  it("honors sample schema mode and a drill-down context in the compose opts", async () => {
    await runPatchStream("test:ask", { write: () => {} }, async (stream) => {
      await runAskQuery({
        ...baseArgs({
          context: {
            schema_mode: "sample",
            drill_down_context: {
              parent_question: "Top regions?",
              filter_column: "region",
              filter_value: "West",
            },
            composer_sight: "sighted",
          },
        }),
        stream,
      } as never);
    });
    const opts = mockedCompose.mock.calls[0][0].opts;
    expect(opts.schemaMode).toBe("sample");
    expect(opts.sight).toBe("sighted");
    expect(opts.drillDownContext?.filter_value).toBe("West");
  });
});
