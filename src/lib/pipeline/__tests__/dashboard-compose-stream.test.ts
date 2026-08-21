/**
 * Harness for `composeAndStreamDashboard` — the generative compose+stream path.
 * The only external boundary is the LLM transport (`ai`.streamText); everything
 * downstream (the shared spec finalizer, placeholder resolution, DataController
 * dataset injection, grounding, and the verifiability panel) runs for real, fed
 * scripted JSONL spec patches. Compiled mode (typed plan call) is exercised
 * separately by the compose-surface tests; this covers the generative branch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── streamText transport mock: yields whatever `nextLines` is set to ──
let nextLines: string[] = [];
let throwOnStream = false;
let throwMidStream = false;
let streamErrorMessage = "model stream exploded";
vi.mock("ai", () => ({
  streamText: vi.fn(() => ({
    // A fresh async iterable per call so a bounded-repair recompose re-streams.
    textStream: (async function* () {
      if (throwOnStream) throw new Error(streamErrorMessage);
      for (const l of nextLines) yield l + "\n";
      if (throwMidStream) throw new Error(`${streamErrorMessage} mid-stream`);
    })(),
  })),
}));
vi.mock("@/lib/llm/client", () => ({
  getModel: vi.fn(() => ({}) as never),
  cachedSystem: vi.fn((s: string) => s),
}));

import { composeAndStreamDashboard } from "@/lib/pipeline/dashboard-compose";
import { parsePatchLines } from "@/lib/pipeline/patch-lines";
import type { SandboxExecutionResult } from "@/lib/contracts/execution";
import type { CSVSchema } from "@/lib/contracts/data-schema";

function makeSchema(): CSVSchema {
  return {
    csv_id: "c1",
    filename: "data.csv",
    row_count: 100,
    columns: [],
    sample_rows: [],
  } as unknown as CSVSchema;
}

function baseOpts(over: Record<string, unknown> = {}) {
  return {
    question: "What drives revenue?",
    schema: makeSchema(),
    schemaMode: "metadata" as const,
    purpose: "dashboard",
    priorTurns: [],
    ...over,
  };
}

async function run(
  exec: SandboxExecutionResult,
  opts: Record<string, unknown>,
  isClosed: () => boolean = () => false
): Promise<{ patches: ReturnType<typeof parsePatchLines>; lines: string[] }> {
  const lines: string[] = [];
  await composeAndStreamDashboard({
    executionResult: exec,
    opts: opts as never,
    uiComposeModel: "m-ui",
    emit: (d) => lines.push(d),
    isClosed,
  });
  return { patches: parsePatchLines(lines), lines };
}

beforeEach(() => {
  vi.clearAllMocks();
  nextLines = [];
  throwOnStream = false;
  throwMidStream = false;
  streamErrorMessage = "model stream exploded";
});

describe("composeAndStreamDashboard — generative path", () => {
  it("resolves $result placeholders and emits purpose + verifiability state", async () => {
    nextLines = [
      '{"op":"add","path":"/root","value":"root"}',
      '{"op":"add","path":"/elements/root","value":{"type":"Grid","props":{},"children":["tile","txt"]}}',
      '{"op":"add","path":"/elements/tile","value":{"type":"StatCard","props":{"label":"Total","value":"$result:total"},"children":[]}}',
      '{"op":"add","path":"/elements/txt","value":{"type":"TextBlock","props":{"content":"Revenue total is $result:total."},"children":[]}}',
    ];
    const exec = {
      success: true,
      results: { total: 1234 },
      chart_data: { bars: [{ x: "A", y: 1 }] },
      datasets: {},
      images: {},
      execution_ms: 5,
    } as unknown as SandboxExecutionResult;

    const { patches, lines } = await run(exec, baseOpts());

    expect(patches.some((p) => p.path === "/root")).toBe(true);
    // $result:total resolved to its value in the emitted element patches
    // (the raw placeholder survives only inside the verifiability plan echo).
    const tile = patches.find((p) => (p.value as { type?: string })?.type === "StatCard");
    expect(JSON.stringify(tile!.value)).toContain("1234");
    expect(JSON.stringify(tile!.value)).not.toContain("$result:total");
    // Final-pass state the composer always stamps.
    expect(patches.some((p) => p.path === "/state/__purpose")).toBe(true);
    expect(patches.some((p) => p.path === "/state/__verifiability")).toBe(true);
  });

  it("injects the dataset + stamps the sample caveat on a DataController run", async () => {
    nextLines = [
      '{"op":"add","path":"/root","value":"root"}',
      '{"op":"add","path":"/elements/root","value":{"type":"DataController","props":{},"children":[]}}',
      '{"op":"add","path":"/state","value":{}}',
    ];
    const exec = {
      success: true,
      // _main_total flags main as a truncated sample → sampleNote is set.
      results: { total: 1234, _main_total: 47000 },
      chart_data: {},
      datasets: {
        main: [
          { region: "West", v: 1 },
          { region: "East", v: 2 },
          { region: "West", v: 3 },
        ],
      },
      images: {},
      execution_ms: 5,
    } as unknown as SandboxExecutionResult;

    const { patches } = await run(exec, baseOpts());

    const statePatch = patches.find((p) => p.path === "/state");
    expect(statePatch).toBeTruthy();
    const datasets = (statePatch!.value as { datasets?: { main?: unknown[] } }).datasets;
    expect(datasets?.main).toHaveLength(3);
    // The DataController element carries the deterministically-stamped caveat.
    const dc = patches.find((p) => (p.value as { type?: string })?.type === "DataController");
    expect((dc!.value as { props: { sample_note?: string } }).props.sample_note).toContain(
      "sample of 3 of 47,000 rows"
    );
  });

  it("emits an inline error element when the model stream throws before any line", async () => {
    throwOnStream = true;
    const exec = {
      success: true,
      results: { total: 1 },
      chart_data: {},
      datasets: {},
      images: {},
      execution_ms: 1,
    } as unknown as SandboxExecutionResult;

    const { patches } = await run(exec, baseOpts());
    expect(patches.some((p) => p.path === "/root" && p.value === "error")).toBe(true);
    expect(patches.some((p) => p.path === "/elements/error")).toBe(true);
  });

  it("rewrites only PROVIDER context-overflow errors, not any 'too long' (L3 backlog #7)", async () => {
    const exec = {
      success: true,
      results: { total: 1 },
      chart_data: {},
      datasets: {},
      images: {},
      execution_ms: 1,
    } as unknown as SandboxExecutionResult;

    // True positive: the Anthropic wording gets the friendly rewrite.
    throwOnStream = true;
    streamErrorMessage = "prompt is too long: 214442 tokens > 200000 maximum";
    const big = await run(exec, baseOpts());
    const bigEl = big.patches.find((p) => p.path === "/elements/error");
    expect((bigEl!.value as { props: { content: string } }).props.content).toContain(
      "too large for the AI"
    );

    // False positive guard: a data-layer error keeps its REAL message.
    streamErrorMessage = "value too long for type character varying(40)";
    const pg = await run(exec, baseOpts());
    const pgEl = pg.patches.find((p) => p.path === "/elements/error");
    const content = (pgEl!.value as { props: { content: string } }).props.content;
    expect(content).toContain("character varying(40)");
    expect(content).not.toContain("too large for the AI");
  });

  it("emits /state/__error when the stream throws AFTER lines were emitted (L3 backlog #4)", async () => {
    // A mid-stream failure used to be log-only once >=1 line had streamed:
    // the run ended cleanly and a truncated dashboard read as success to
    // every patch-stream consumer (CLI, MCP analyze, history save).
    nextLines = [
      '{"op":"add","path":"/root","value":"root"}',
      '{"op":"add","path":"/elements/root","value":{"type":"Grid","props":{},"children":[]}}',
    ];
    throwMidStream = true;
    const exec = {
      success: true,
      results: { total: 1 },
      chart_data: {},
      datasets: {},
      images: {},
      execution_ms: 1,
    } as unknown as SandboxExecutionResult;

    const { patches } = await run(exec, baseOpts());
    const err = patches.find((p) => p.path === "/state/__error");
    expect(typeof err?.value).toBe("string");
    expect(String(err?.value)).toContain("exploded mid-stream");
    // The shared reader now reports the run as failed.
    const { readRunError } = await import("@/lib/pipeline/patch-lines");
    expect(readRunError(patches)).toContain("exploded mid-stream");
  });

  it("skips grounding/verifiability work once the client has disconnected", async () => {
    nextLines = [
      '{"op":"add","path":"/root","value":"root"}',
      '{"op":"add","path":"/elements/root","value":{"type":"Grid","props":{},"children":[]}}',
    ];
    const exec = {
      success: true,
      results: { total: 1 },
      chart_data: {},
      datasets: {},
      images: {},
      execution_ms: 1,
    } as unknown as SandboxExecutionResult;

    const { patches } = await run(exec, baseOpts(), () => true);
    // The post-stream grounding/verifiability block is gated on !isClosed.
    expect(patches.some((p) => p.path === "/state/__verifiability")).toBe(false);
  });

  it("gates a shipped blocking-check failure and reports checks in verifiability", async () => {
    nextLines = [
      '{"op":"add","path":"/root","value":"root"}',
      '{"op":"add","path":"/elements/root","value":{"type":"Grid","props":{},"children":["txt"]}}',
      '{"op":"add","path":"/elements/txt","value":{"type":"TextBlock","props":{"content":"Churn is rising ($finding:churn_trend)."},"children":[]}}',
    ];
    const exec = {
      success: true,
      results: { total: 100 },
      chart_data: {},
      datasets: {},
      images: {},
      execution_ms: 1,
    } as unknown as SandboxExecutionResult;
    const findings = {
      manifest: {
        manifest_version: "1.0",
        findings: [
          {
            name: "churn_trend",
            definition: "OLS trend of churn",
            dtype: "trend",
            unit: "%",
            value: { direction: "rising", p_value: 0.01 },
          },
          {
            name: "row_count_check",
            definition: "expected row count",
            dtype: "check",
            tags: ["blocking"],
            value: { passed: false },
          },
        ],
      },
      issues: [],
    };

    const { patches } = await run(exec, baseOpts({ findings, sight: "sighted" }));

    // A failed blocking check ships GATED — a server-injected warning banner.
    expect(patches.some((p) => p.path === "/elements/hermetic_blocking_gate")).toBe(true);
    // The verifiability panel counts the check and lists it as failed.
    const verif = patches.find((p) => p.path === "/state/__verifiability");
    const v = verif!.value as {
      composerSight: string;
      findings: { declared: number; cited: number; checks: number; failedChecks: string[] };
    };
    expect(v.composerSight).toBe("sighted");
    expect(v.findings.declared).toBe(2);
    expect(v.findings.checks).toBe(1);
    expect(v.findings.failedChecks).toContain("row_count_check");
    // The prose cited the declared finding.
    expect(v.findings.cited).toBeGreaterThanOrEqual(1);
  });

  it("runs a bounded repair recompose when the composed spec has no narrative", async () => {
    // Tiles only, no prose element → the no_narrative severe advisory fires,
    // triggering exactly one bounded-repair recompose (second pass carries
    // repairAdvisories, so it never recurses again).
    nextLines = [
      '{"op":"add","path":"/root","value":"root"}',
      '{"op":"add","path":"/elements/root","value":{"type":"Grid","props":{},"children":["tile"]}}',
      '{"op":"add","path":"/elements/tile","value":{"type":"StatCard","props":{"label":"Total","value":1234},"children":[]}}',
    ];
    const exec = {
      success: true,
      results: { total: 1234 },
      chart_data: {},
      datasets: {},
      images: {},
      execution_ms: 1,
    } as unknown as SandboxExecutionResult;

    const { streamText } = await import("ai");
    await run(exec, baseOpts());
    // Two compose passes = two streamText calls (initial + bounded repair).
    expect(vi.mocked(streamText).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
