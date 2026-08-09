/**
 * Restored analyses stay editable: a ?restore= mints a FRESH csvId, so
 * every csvId-keyed lookup maps to nothing — the observed "This dashboard
 * isn't editable" on a compiled dashboard whose record demonstrably holds
 * the plan. The history id is the stable key the restore flow actually
 * has; getEditSurface/editDashboard accept it and resolve the persisted
 * artifacts by the entry's own id.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPathRoots } from "@/lib/paths";
import { saveHistoryEntry, loadArtifactsByHistoryId } from "@/lib/history/storage";
import { getEditSurface } from "@/lib/compose/edit";
import type { CSVSchema } from "@/lib/contracts/data-schema";
import type { CachedArtifacts } from "@/lib/contracts/investigation";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "hermetic-restore-edit-"));
  setPathRoots({ dataRoot: dir });
});

afterAll(() => {
  setPathRoots({});
  rmSync(dir, { recursive: true, force: true });
});

const schema: CSVSchema = {
  csv_id: "orig-csv",
  filename: "churn.csv",
  row_count: 4,
  columns: [],
  sample_rows: [],
};

const ARTIFACTS: CachedArtifacts = {
  code: "print(1)",
  question: "what is churn?",
  results: {},
  chart_data: {},
  datasets: {},
  execution_ms: 5,
  findings: {
    manifest_version: "1",
    findings: [
      {
        name: "churn_trend",
        dtype: "direction",
        definition: "trend of churn",
        value: { direction: "rising", slope_per_period: 0.9 },
      },
    ],
  } as CachedArtifacts["findings"],
  series: [],
  plan: {
    mode: "compiled",
    purpose: "deep-dive",
    plan: { nodes: [{ id: "n_a", op: "ANSWER", refs: ["churn_trend"] }] },
    overlay: {},
  },
};

describe("restored compiled dashboards remain editable", () => {
  it("getEditSurface resolves by history id when the fresh csvId maps to nothing", async () => {
    const meta = await saveHistoryEntry({
      question: "what is churn?",
      spec: { root: "r", elements: {} },
      generatedCode: "print(1)",
      schema,
      artifacts: ARTIFACTS,
      sourceFile: "churn.csv",
      sourceType: "upload",
      executionMs: 5,
    });
    expect((await loadArtifactsByHistoryId(meta.id))?.plan?.mode).toBe("compiled");

    // The restore flow's exact situation: a freshly minted csvId that no
    // meta references, plus the history id it restored from.
    const surface = await getEditSurface("freshly-minted-csv-id", meta.id);
    expect(surface).not.toBeNull();
    expect(surface!.doc.mode).toBe("compiled");
    expect(surface!.sections.map((s) => s.id)).toContain("n_a");

    // Without the history id, the fresh csvId resolves nothing — the bug.
    expect(await getEditSurface("freshly-minted-csv-id")).toBeNull();
  });
});
