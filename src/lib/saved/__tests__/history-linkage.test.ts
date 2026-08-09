/**
 * Saved vizs carry the history-entry id of their analysis (meta.historyId) —
 * the audit key. Regression for the restored-viz dead audit button: saved
 * vizs and history entries are SEPARATE id namespaces, and the page used to
 * improvise a "history id" from `loadedVizId ?? liveHistoryId`, which is
 * null after a ?restore= (button disabled on the very entry it restored)
 * and a vizId after a viz load (enabled button, guaranteed audit failure).
 * The linkage is persisted at save time and must survive load + versioning.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPathRoots } from "@/lib/paths";
import { saveVisualization, saveNewVersion, loadSavedVisualization } from "@/lib/saved/storage";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "hermetic-viz-linkage-"));
  setPathRoots({ dataRoot: dir });
});

afterAll(() => {
  setPathRoots({});
  rmSync(dir, { recursive: true, force: true });
});

const BASE = {
  question: "how have prices changed?",
  csvFilename: "menus.csv",
  csvContent: "year,price\n1900,0.4\n",
  generatedCode: "print('x')",
  spec: { elements: [] } as Record<string, unknown>,
};

describe("saved-viz history linkage", () => {
  it("persists historyId through save and load", async () => {
    const meta = await saveVisualization({ ...BASE, historyId: "abc123def456" });
    expect(meta.historyId).toBe("abc123def456");
    const loaded = await loadSavedVisualization(meta.vizId);
    expect(loaded.meta.historyId).toBe("abc123def456");
  });

  it("is absent, never fabricated, when no history entry existed at save", async () => {
    const meta = await saveVisualization({ ...BASE });
    const loaded = await loadSavedVisualization(meta.vizId);
    expect(loaded.meta.historyId).toBeUndefined();
  });

  it("versioning follows the latest analysis and preserves when unknown", async () => {
    const meta = await saveVisualization({ ...BASE, historyId: "aaa111bbb222" });
    // New version without a known history id: keep the old linkage rather
    // than erase it.
    const kept = await saveNewVersion(meta.vizId, {
      ...BASE,
      schemaFingerprint: "fp1",
    });
    expect(kept.historyId).toBe("aaa111bbb222");
    // New version from a fresh analysis: the audit key moves with it.
    const moved = await saveNewVersion(meta.vizId, {
      ...BASE,
      schemaFingerprint: "fp2",
      historyId: "ccc333ddd444",
    });
    expect(moved.historyId).toBe("ccc333ddd444");
    const loaded = await loadSavedVisualization(meta.vizId);
    expect(loaded.meta.historyId).toBe("ccc333ddd444");
  });
});
