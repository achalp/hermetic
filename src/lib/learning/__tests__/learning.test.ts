/**
 * The learning loop, exercised with run a47b45ba's real failure shapes:
 * ledger dedup + graduation, capitulation guard, engine-defect routing,
 * exemplar bank + retrieval floor, and proposal → complement-skill apply.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({ generateText: generateTextMock }));
vi.mock("@/lib/llm/client", () => ({ getModel: vi.fn(() => "model") }));

import { setPathRoots } from "@/lib/paths";
import { recordCandidate, loadLedger, GRADUATION_THRESHOLD } from "../ledger";
import { extractLessons, engineSuggestionOf, isEngineDefect, diffSummary } from "../extract";
import { bankExemplar, retrieveExemplar, listExemplars } from "../exemplars";
import { createProposal, acceptProposal, rejectProposal, listProposals } from "../proposals";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "learning-test-"));
  setPathRoots({ dataRoot: root });
  generateTextMock.mockReset();
});
afterEach(() => {
  setPathRoots({});
  rmSync(root, { recursive: true, force: true });
});

const REGION_ERROR = `Traceback (most recent call last):
  File "/data/script.py", line 539, in <module>
    raise ValueError("San Francisco not found in division_area — check subtype/name/country filters")
ValueError: San Francisco not found in division_area — check subtype/name/country filters`;

const QUANTILE_ERROR = `duckdb.duckdb.CatalogException: Catalog Error: Scalar Function with name approx_percentile does not exist!
Did you mean "approx_quantile"?`;

const SHAPE_ERROR = `Output JSON has the wrong shape for write_output — chart_data: Invalid input: expected record, received array.`;

function candidate(over: Partial<Parameters<typeof recordCandidate>[0]> = {}) {
  return {
    kind: "domain-guidance" as const,
    parentSkill: "geo-overture",
    failureClass: "py_ValueError",
    lessonText: "division_area lookups: do not filter region.",
    retreat: false,
    errorText: REGION_ERROR,
    evidence: { runId: "run-1", ts: "2026-08-05T00:00:00Z", errorHead: "ValueError…" },
    ...over,
  };
}

describe("ledger", () => {
  it("dedups by fingerprint across runs and graduates at the threshold", async () => {
    const r1 = await recordCandidate(candidate());
    expect(r1.graduated).toBe(false);
    // Same failure, different run + different literal values → same entry.
    const r2 = await recordCandidate(
      candidate({
        errorText: REGION_ERROR.replace("San Francisco", "Los Angeles").replace("539", "612"),
        evidence: { runId: "run-2", ts: "2026-08-05T01:00:00Z", errorHead: "ValueError…" },
      })
    );
    expect(r2.graduated).toBe(true);
    const ledger = await loadLedger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].evidence).toHaveLength(GRADUATION_THRESHOLD);
  });

  it("same-run duplicates do not double-count evidence", async () => {
    await recordCandidate(candidate());
    const r = await recordCandidate(candidate());
    expect(r.entry.evidence).toHaveLength(1);
    expect(r.graduated).toBe(false);
  });

  it("retreat lessons never auto-graduate", async () => {
    await recordCandidate(candidate({ retreat: true }));
    const r = await recordCandidate(
      candidate({
        retreat: true,
        evidence: { runId: "run-2", ts: "t", errorHead: "e" },
      })
    );
    expect(r.graduated).toBe(false);
  });

  it("unattributed and engine-defect lessons never graduate", async () => {
    await recordCandidate(candidate({ parentSkill: undefined }));
    const r1 = await recordCandidate(
      candidate({ parentSkill: undefined, evidence: { runId: "r2", ts: "t", errorHead: "e" } })
    );
    expect(r1.graduated).toBe(false);
    await recordCandidate(candidate({ kind: "engine-defect", errorText: SHAPE_ERROR }));
    const r2 = await recordCandidate(
      candidate({
        kind: "engine-defect",
        errorText: SHAPE_ERROR,
        evidence: { runId: "r3", ts: "t", errorHead: "e" },
      })
    );
    expect(r2.graduated).toBe(false);
  });

  it("a rejected fingerprint stays rejected (no evidence accretion, no re-proposal)", async () => {
    await recordCandidate(candidate());
    const { entry, graduated } = await recordCandidate(
      candidate({ evidence: { runId: "run-2", ts: "t", errorHead: "e" } })
    );
    expect(graduated).toBe(true);
    const proposal = await createProposal(entry);
    await rejectProposal(proposal.id);
    const r3 = await recordCandidate(
      candidate({ evidence: { runId: "run-3", ts: "t", errorHead: "e" } })
    );
    expect(r3.graduated).toBe(false);
    expect(r3.entry.status).toBe("rejected");
    expect(r3.entry.evidence).toHaveLength(2); // no accretion after the no
  });
});

describe("extraction", () => {
  it("routes output-contract failures to engine-defect without an LLM call", async () => {
    const lessons = await extractLessons([{ error: SHAPE_ERROR, code: "x" }]);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].kind).toBe("engine-defect");
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("flags a capitulation when the fix ignored the engine's own suggestion", async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        lessons: [{ kind: "dialect-fact", lessonText: "Avoid percentiles.", retreat: false }],
      }),
    });
    const lessons = await extractLessons([
      {
        error: QUANTILE_ERROR,
        code: "x = approx_percentile(v, 0.5)",
        // The "fix" DROPPED the stat instead of adopting approx_quantile.
        fixedCode: "x = None  # stats removed",
      },
    ]);
    expect(lessons[0].retreat).toBe(true);
    expect(lessons[0].engineSuggestion).toBe("approx_quantile");
  });

  it("a fix that adopts the suggestion is not a retreat", async () => {
    generateTextMock.mockResolvedValue({
      text: JSON.stringify({
        lessons: [{ kind: "dialect-fact", lessonText: "DuckDB: approx_quantile.", retreat: false }],
      }),
    });
    const lessons = await extractLessons([
      { error: QUANTILE_ERROR, code: "approx_percentile(v)", fixedCode: "approx_quantile(v)" },
    ]);
    expect(lessons[0].retreat).toBe(false);
  });

  it("fails open: extraction errors yield [] (plus any pre-routed defects)", async () => {
    generateTextMock.mockRejectedValue(new Error("provider down"));
    const lessons = await extractLessons([
      { error: REGION_ERROR, code: "a" },
      { error: SHAPE_ERROR, code: "b" },
    ]);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].kind).toBe("engine-defect");
  });

  it("helpers: suggestion parsing, defect detection, diff summary", () => {
    expect(engineSuggestionOf(QUANTILE_ERROR)).toBe("approx_quantile");
    expect(isEngineDefect(SHAPE_ERROR)).toBe(true);
    expect(isEngineDefect(REGION_ERROR)).toBe(false);
    const d = diffSummary("a\nb\nc", "a\nB2\nc");
    expect(d).toContain("removed: b");
    expect(d).toContain("added: B2");
  });
});

describe("exemplar bank", () => {
  const COLS = [
    { name: "geometry", dtype: "object" },
    { name: "area", dtype: "float64" },
  ];
  const bank = (over: Partial<Parameters<typeof bankExemplar>[0]> = {}) =>
    bankExemplar({
      runId: "run-9",
      question: "Which building has the largest footprint area",
      columns: COLS,
      detectedDomain: "geospatial",
      activeSkills: ["geo-overture"],
      code: "print('verified')",
      attempts: 4,
      rowCount: 100,
      ...over,
    });

  it("banks, dedups same shape+question, and retrieves on schema match", async () => {
    await bank();
    await bank({ code: "print('newer')" }); // same shape+question → update
    expect(await listExemplars()).toHaveLength(1);
    const hit = await retrieveExemplar({
      question: "largest footprint building?",
      columns: COLS,
      detectedDomain: "geospatial",
      activeSkills: ["geo-overture"],
    });
    expect(hit?.code).toBe("print('newer')");
  });

  it("retrieval floor keeps weak matches out of the prompt", async () => {
    await bank();
    const miss = await retrieveExemplar({
      question: "monthly recurring revenue trend",
      columns: [{ name: "mrr", dtype: "float64" }],
      detectedDomain: "time_series",
      activeSkills: [],
    });
    expect(miss).toBeNull();
  });
});

describe("proposals → complement skill", () => {
  it("accepting writes data/skills/<parent>-learned with extends frontmatter; second accept appends", async () => {
    const { entry } = await recordCandidate(candidate());
    const { entry: e2, graduated } = await recordCandidate(
      candidate({ evidence: { runId: "run-2", ts: "t", errorHead: "e" } })
    );
    expect(graduated).toBe(true);
    const p1 = await createProposal(e2);
    const { applied, path } = await acceptProposal(p1.id);
    expect(applied).toBe(true);
    const md = readFileSync(path, "utf-8");
    expect(md).toContain("name: geo-overture-learned");
    expect(md).toContain("extends: geo-overture");
    expect(md).toContain("do not filter region");
    expect(entry.id).toBe(e2.id);

    // Second graduated lesson for the same parent → appended bullet.
    const { entry: e3, graduated: g3 } = await (async () => {
      await recordCandidate(
        candidate({
          lessonText: "DuckDB uses approx_quantile, not approx_percentile.",
          errorText: QUANTILE_ERROR,
          failureClass: "py_CatalogException",
          kind: "dialect-fact",
        })
      );
      return recordCandidate(
        candidate({
          lessonText: "DuckDB uses approx_quantile, not approx_percentile.",
          errorText: QUANTILE_ERROR,
          failureClass: "py_CatalogException",
          kind: "dialect-fact",
          evidence: { runId: "run-5", ts: "t", errorHead: "e" },
        })
      );
    })();
    expect(g3).toBe(true);
    const p2 = await createProposal(e3);
    await acceptProposal(p2.id);
    const md2 = readFileSync(path, "utf-8");
    expect(md2).toContain("do not filter region");
    expect(md2).toContain("approx_quantile");
    // Still ONE complement file, both bullets under it.
    expect(existsSync(path)).toBe(true);
  });

  it("reject marks proposal and ledger; accept of decided proposal is a no-op", async () => {
    await recordCandidate(candidate());
    const { entry } = await recordCandidate(
      candidate({ evidence: { runId: "run-2", ts: "t", errorHead: "e" } })
    );
    const p = await createProposal(entry);
    await rejectProposal(p.id);
    expect((await listProposals())[0].status).toBe("rejected");
    const again = await acceptProposal(p.id);
    expect(again.applied).toBe(false);
  });
});
