/**
 * Regression test for the HermeticPaths seam (lib/paths.ts): setPathRoots is
 * called AFTER these storage modules were imported, and their writes must
 * still land under the injected roots. Module-level path constants used to
 * freeze the pre-boot defaults at import time, silently defeating the seam
 * for any harness that booted after module load.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, readdir, stat, rm } from "fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CSVSchema } from "@/lib/contracts/data-schema";
// Imported BEFORE setPathRoots runs — that ordering is the point of the test.
import { appendCostRow } from "@/lib/cost/storage";
import {
  setSchedule,
  __clearScheduleCache,
  __getSchedulesPath,
} from "@/lib/saved/schedule-storage";
import { writeSchemaCache, readSchemaCache } from "@/lib/schema-cache";
import { recordRecentSource, loadRecentSources } from "@/lib/sources/recent-sources";
import { setRuntimeConfig, clearRuntimeConfigCache } from "@/lib/runtime-config";
import { saveHistoryEntry, loadHistoryEntry } from "@/lib/history/storage";
import { setPathRoots } from "@/lib/paths";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "hermetic-path-roots-"));
  setPathRoots({
    dataRoot: join(root, "data"),
    scratchRoot: join(root, "scratch"),
    userRoot: join(root, "user"),
  });
  __clearScheduleCache();
  clearRuntimeConfigCache();
});

afterAll(async () => {
  setPathRoots({});
  __clearScheduleCache();
  clearRuntimeConfigCache();
  await rm(root, { recursive: true, force: true });
});

describe("setPathRoots after import still redirects writes", () => {
  it("cost rows land under <root>/data/cost", async () => {
    const date = new Date().toISOString().slice(0, 10);
    await appendCostRow({
      timestamp: new Date().toISOString(),
      date,
      dataset: "seam.csv",
      question: "does the seam hold?",
      mode: "ask",
      models: "m",
      llm_calls: 1,
      input_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      output_tokens: 1,
      cost_usd: 0.000001,
    });
    const content = await readFile(join(root, "data", "cost", `${date}.csv`), "utf-8");
    expect(content).toContain("does the seam hold?");
  });

  it("schedules.json lands under <root>/data", async () => {
    expect(__getSchedulesPath()).toBe(join(root, "data", "schedules.json"));
    await setSchedule({ vizId: "seam-viz", cadence: "hourly", autoExport: [] });
    const raw = await readFile(join(root, "data", "schedules.json"), "utf-8");
    expect(JSON.parse(raw)[0].vizId).toBe("seam-viz");
  });

  it("schema cache entries land under <root>/data/schema-cache", async () => {
    await writeSchemaCache("seam-source", "fp-1", { hello: "world" });
    const files = await readdir(join(root, "data", "schema-cache"));
    expect(files.some((f) => f.endsWith(".json"))).toBe(true);
    const entry = await readSchemaCache<{ hello: string }>("seam-source");
    expect(entry?.artifact.hello).toBe("world");
  });

  it("recent sources land under <root>/user", async () => {
    await recordRecentSource({
      kind: "remote-parquet",
      name: "events.parquet",
      subtitle: "s3://bucket/events.parquet",
      url: "s3://bucket/events.parquet",
    });
    const raw = await readFile(join(root, "user", "recent-sources.json"), "utf-8");
    expect(JSON.parse(raw)[0].url).toBe("s3://bucket/events.parquet");
    expect((await loadRecentSources())[0].name).toBe("events.parquet");
  });

  it("runtime-config.json lands under <root>/data", async () => {
    setRuntimeConfig({ activeProvider: "ollama" });
    const raw = await readFile(join(root, "data", "runtime-config.json"), "utf-8");
    expect(JSON.parse(raw).activeProvider).toBe("ollama");
  });

  it("history records land under <root>/data/history (constructor capture)", async () => {
    const meta = await saveHistoryEntry({
      question: "q",
      spec: { root: "r", elements: { r: { type: "BarChart", props: { title: "t" } } } },
      generatedCode: "print(1)",
      schema: { columns: [], row_count: 0 } as unknown as CSVSchema,
      sourceFile: "seam.csv",
      sourceType: "upload",
      executionMs: 1,
    });
    await stat(join(root, "data", "history", meta.id, "meta.json"));
    const loaded = await loadHistoryEntry(meta.id);
    expect(loaded.meta.question).toBe("q");
  });

  it("a subsequent root change is honored too (no first-call freeze)", async () => {
    const root2 = await mkdtemp(join(tmpdir(), "hermetic-path-roots2-"));
    try {
      setPathRoots({ dataRoot: join(root2, "data") });
      clearRuntimeConfigCache();
      setRuntimeConfig({ activeProvider: "mlx" });
      const raw = await readFile(join(root2, "data", "runtime-config.json"), "utf-8");
      expect(JSON.parse(raw).activeProvider).toBe("mlx");
    } finally {
      setPathRoots({
        dataRoot: join(root, "data"),
        scratchRoot: join(root, "scratch"),
        userRoot: join(root, "user"),
      });
      clearRuntimeConfigCache();
      await rm(root2, { recursive: true, force: true });
    }
  });
});
