/**
 * The non-blind audit is part of the history RECORD (RECORD_FILES.audit),
 * not a raw side-file — regression for the gap where audit.json was written
 * with a bare writeFileSync the record contract knew nothing about, so
 * loadHistoryEntry (and every export path built on it) silently omitted the
 * audit while returning "the other artifacts".
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPathRoots } from "@/lib/paths";
import {
  saveHistoryEntry,
  loadHistoryEntry,
  saveHistoryAudit,
  loadHistoryAudit,
} from "@/lib/history/storage";
import type { PersistedAudit } from "@/lib/contracts/storage-types";
import type { CSVSchema } from "@/lib/contracts/data-schema";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "hermetic-audit-record-"));
  setPathRoots({ dataRoot: dir });
});

afterAll(() => {
  setPathRoots({});
  rmSync(dir, { recursive: true, force: true });
});

const schema: CSVSchema = {
  csv_id: "c1",
  filename: "data.csv",
  row_count: 3,
  columns: [],
  sample_rows: [],
};

const AUDIT: PersistedAudit = {
  verdict: "issues",
  findings: [{ severity: "high", claim: "max disagrees with chart", evidence: "7000 vs 30000" }],
  at: 1754680000000,
  model: "claude-sonnet-5",
};

describe("history audit record", () => {
  it("saves through the store and loads along with the other artifacts", async () => {
    const meta = await saveHistoryEntry({
      question: "q",
      spec: { root: "r", elements: {} },
      generatedCode: "print(1)",
      schema,
      artifacts: {
        code: "print(1)",
        question: "q",
        results: { total: 1 },
        chart_data: {},
        datasets: {},
        execution_ms: 5,
      },
      sourceFile: "data.csv",
      sourceType: "upload",
      executionMs: 5,
    });

    // Before an audit runs: absent, not an error.
    expect((await loadHistoryEntry(meta.id)).audit).toBeUndefined();
    expect(await loadHistoryAudit(meta.id)).toBeUndefined();

    await saveHistoryAudit(meta.id, AUDIT);

    // The dedicated reader (the /api/audit GET) and the full entry load
    // (restore/export surfaces) both see the same persisted verdict.
    expect(await loadHistoryAudit(meta.id)).toEqual(AUDIT);
    const entry = await loadHistoryEntry(meta.id);
    expect(entry.audit).toEqual(AUDIT);
    expect(entry.artifacts?.results).toEqual({ total: 1 }); // rest of the record intact
  });
});
