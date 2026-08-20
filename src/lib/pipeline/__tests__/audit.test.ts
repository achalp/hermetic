import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildAuditPrompt,
  parseAuditResponse,
  AUDIT_BUNDLE_MAX_BYTES,
  runAudit,
  auditHistoryEntry,
} from "@/lib/pipeline/audit";

// ── Boundary mocks for runAudit / auditHistoryEntry ──────────────────
vi.mock("ai", () => ({ generateText: vi.fn() }));
vi.mock("@/lib/llm/client", () => ({
  getModel: vi.fn(() => ({}) as never),
  cachedSystem: vi.fn((s: string) => s),
}));
vi.mock("@/lib/history/storage", () => ({
  loadHistoryEntry: vi.fn(),
  saveHistoryAudit: vi.fn(async () => {}),
}));
vi.mock("@/lib/pipeline/grounding", () => ({
  collectNarrativeStrings: vi.fn(() => ["a narrative sentence"]),
}));

import { generateText } from "ai";
import { loadHistoryEntry, saveHistoryAudit } from "@/lib/history/storage";

const mockedGen = vi.mocked(generateText);
const mockedLoad = vi.mocked(loadHistoryEntry);
const mockedSave = vi.mocked(saveHistoryAudit);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("audit prompt/parse (composer-sight spec §3)", () => {
  it("bundles derived artifacts, samples long series, and stays bounded", () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ year: 1500 + i, v: i }));
    const prompt = buildAuditPrompt({
      question: "how have prices changed",
      results: { total: 1 },
      findings: [{ name: "t", value: { direction: "rising" } }],
      chartData: { series: rows },
      narrativeTexts: ["Median rose."],
      sql: "SELECT 1",
    });
    expect(prompt).toContain("how have prices changed");
    expect(prompt).toContain('"rows":500');
    expect(Buffer.byteLength(prompt, "utf-8")).toBeLessThan(AUDIT_BUNDLE_MAX_BYTES + 2000);
  });

  it("drops chart_data when the bundle overflows the byte budget", () => {
    // A non-array chart_data value (not head/tail-sampled) large enough to blow
    // the cap forces the over-budget branch that deletes chart_data.
    const prompt = buildAuditPrompt({
      question: "q",
      results: {},
      chartData: { big: { blob: "x".repeat(70000) } },
    });
    expect(prompt).not.toContain("chart_data");
    expect(Buffer.byteLength(prompt, "utf-8")).toBeLessThan(AUDIT_BUNDLE_MAX_BYTES);
  });

  it("parses a verdict, tolerates prose around JSON, rejects garbage", () => {
    const ok = parseAuditResponse(
      'Here: {"verdict":"issues","findings":[{"severity":"high","claim":"c","evidence":"e"}]} done'
    );
    expect(ok?.verdict).toBe("issues");
    expect(ok?.findings[0].severity).toBe("high");
    expect(parseAuditResponse("no json at all")).toBeNull();
    expect(parseAuditResponse('{"verdict":"nope"}')).toBeNull();
  });
});

describe("runAudit", () => {
  it("returns the parsed verdict stamped with at/model on a clean response", async () => {
    mockedGen.mockResolvedValue({ text: '{"verdict":"clean","findings":[]}' } as never);
    const result = await runAudit({ question: "q", results: { total: 1 } });
    expect(result?.verdict).toBe("clean");
    expect(typeof result?.at).toBe("number");
    expect(typeof result?.model).toBe("string");
    expect(mockedGen).toHaveBeenCalledTimes(1);
  });

  it("returns null when the model response cannot be parsed", async () => {
    mockedGen.mockResolvedValue({ text: "not json" } as never);
    expect(await runAudit({ question: "q" })).toBeNull();
  });

  it("never throws — an LLM error returns null", async () => {
    mockedGen.mockRejectedValue(new Error("API down"));
    expect(await runAudit({ question: "q" })).toBeNull();
  });
});

describe("auditHistoryEntry", () => {
  const entry = {
    meta: { question: "how have prices changed" },
    artifacts: {
      results: { total: 1 },
      chart_data: { s: [{ x: 1 }] },
      findings: [{ name: "t" }],
      sql: "SELECT 1",
    },
    spec: { root: "r", elements: {} },
  };

  it("audits the derived bundle and persists the verdict", async () => {
    mockedLoad.mockResolvedValue(entry as never);
    mockedGen.mockResolvedValue({ text: '{"verdict":"issues","findings":[]}' } as never);
    const result = await auditHistoryEntry("hist-1");
    expect(result?.verdict).toBe("issues");
    expect(mockedSave).toHaveBeenCalledWith(
      "hist-1",
      expect.objectContaining({ verdict: "issues" })
    );
  });

  it("does not persist (and returns null) when the audit yields nothing", async () => {
    mockedLoad.mockResolvedValue(entry as never);
    mockedGen.mockResolvedValue({ text: "garbage" } as never);
    const result = await auditHistoryEntry("hist-2");
    expect(result).toBeNull();
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("swallows a persistence failure but still returns the verdict", async () => {
    mockedLoad.mockResolvedValue({ ...entry, artifacts: {} } as never);
    mockedGen.mockResolvedValue({ text: '{"verdict":"clean","findings":[]}' } as never);
    mockedSave.mockRejectedValueOnce(new Error("disk full"));
    const result = await auditHistoryEntry("hist-3");
    expect(result?.verdict).toBe("clean");
  });
});
