import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { rm, readFile, access } from "node:fs/promises";

// Hoisted so the vi.mock factory (itself hoisted) can close over it without TDZ.
const { TEST_HOME } = vi.hoisted(() => ({
  TEST_HOME: `${process.env.TMPDIR || "/tmp"}/hermetic-recent-test`.replace(/\/{2,}/g, "/"),
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => TEST_HOME };
});

import {
  recordRecentSource,
  loadRecentSources,
  renameRecentSource,
  removeRecentSource,
  clearRecentSources,
} from "@/lib/sources/recent-sources";

const SOURCES_DIR = join(TEST_HOME, ".hermetic", "sources");
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false
  );

beforeEach(() => rm(TEST_HOME, { recursive: true, force: true }));
afterEach(() => rm(TEST_HOME, { recursive: true, force: true }));

describe("recent sources store", () => {
  it("records a remote-parquet source with its URL and creds", async () => {
    await recordRecentSource({
      kind: "remote-parquet",
      name: "buildings",
      subtitle: "s3://overture/buildings/*.parquet",
      rows: 2_500_000_000,
      url: "s3://overture/buildings/*.parquet",
      creds: { s3Region: "us-west-2" },
      isHivePartitioned: true,
    });
    const [entry] = await loadRecentSources();
    expect(entry.kind).toBe("remote-parquet");
    expect(entry.url).toBe("s3://overture/buildings/*.parquet");
    expect(entry.creds).toEqual({ s3Region: "us-west-2" });
    expect(entry.useCount).toBe(1);
  });

  it("dedups a re-opened source and bumps useCount instead of duplicating", async () => {
    const rec = () =>
      recordRecentSource({ kind: "remote-parquet", name: "b", subtitle: "u", url: "s3://b/x" });
    await rec();
    await rec();
    const list = await loadRecentSources();
    expect(list).toHaveLength(1);
    expect(list[0].useCount).toBe(2);
  });

  it("persists upload bytes into the managed store and re-reads them", async () => {
    await recordRecentSource({
      kind: "upload",
      name: "finance.csv",
      subtitle: "Uploaded file",
      rows: 3,
      bytes: "a,b\n1,2\n",
      filename: "finance.csv",
    });
    const [entry] = await loadRecentSources();
    expect(entry.managed).toBe(true);
    expect(entry.path?.startsWith(SOURCES_DIR)).toBe(true);
    expect(entry.path?.endsWith(".csv")).toBe(true);
    expect(await readFile(entry.path!, "utf-8")).toBe("a,b\n1,2\n");
  });

  it("removing an upload deletes its managed bytes", async () => {
    await recordRecentSource({
      kind: "upload",
      name: "x.csv",
      subtitle: "Uploaded file",
      bytes: "h\n1\n",
      filename: "x.csv",
    });
    const [entry] = await loadRecentSources();
    expect(await exists(entry.path!)).toBe(true);
    await removeRecentSource(entry.id);
    expect(await loadRecentSources()).toHaveLength(0);
    expect(await exists(entry.path!)).toBe(false);
  });

  it("renames a source, keeping its identity", async () => {
    // Path must EXIST — load-time pruning drops dead path-backed entries.
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(TEST_HOME, "data"), { recursive: true });
    const rawPath = join(TEST_HOME, "data", "raw.parquet");
    await writeFile(rawPath, "x");
    await recordRecentSource({
      kind: "local-file",
      name: "raw.parquet",
      subtitle: rawPath,
      path: rawPath,
    });
    const [before] = await loadRecentSources();
    await renameRecentSource(before.id, "Q3 raw");
    const [after] = await loadRecentSources();
    expect(after.id).toBe(before.id);
    expect(after.name).toBe("Q3 raw");
  });

  it("caps the history and evicts the least-recently-used", async () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 30; i++) {
        vi.setSystemTime(1_600_000_000_000 + i * 1000); // monotonic lastUsedAt
        // URL-backed kind: exempt from existence pruning, so the cap is
        // what this test actually exercises.
        await recordRecentSource({
          kind: "remote-parquet",
          name: `f${i}`,
          subtitle: `s3://bucket/f${i}`,
          url: `s3://bucket/f${i}`,
        });
      }
    } finally {
      vi.useRealTimers();
    }
    const list = await loadRecentSources();
    expect(list.length).toBeLessThanOrEqual(24);
    // The most recent (f29) survives; the oldest (f0) was evicted.
    expect(list.some((e) => e.name === "f29")).toBe(true);
    expect(list.some((e) => e.name === "f0")).toBe(false);
  });

  it("clears everything, including managed upload bytes", async () => {
    await recordRecentSource({
      kind: "upload",
      name: "u.csv",
      subtitle: "Uploaded file",
      bytes: "h\n1\n",
      filename: "u.csv",
    });
    const [entry] = await loadRecentSources();
    await clearRecentSources();
    expect(await loadRecentSources()).toHaveLength(0);
    expect(await exists(entry.path!)).toBe(false);
  });
});

describe("hygiene (found live: proof-run fixtures polluting the menu)", () => {
  it("prunes path-backed entries whose file no longer exists, and persists the prune", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const liveDir = join(TEST_HOME, "live");
    await mkdir(liveDir, { recursive: true });
    const livePath = join(liveDir, "kept.csv");
    await writeFile(livePath, "a\n1\n");

    await recordRecentSource({
      kind: "local-file",
      name: "kept.csv",
      subtitle: livePath,
      path: livePath,
    });
    await recordRecentSource({
      kind: "local-file",
      name: "fixture.csv",
      subtitle: "/tmp/mcp-proof-dead/fixture.csv",
      path: join(TEST_HOME, "gone", "fixture.csv"),
    });
    await recordRecentSource({
      kind: "remote-parquet",
      name: "buildings",
      subtitle: "s3://x/y",
      url: "s3://x/y",
    });

    const list = await loadRecentSources();
    expect(list.map((e) => e.name).sort()).toEqual(["buildings", "kept.csv"]);
    // The prune persisted: a re-read (raw file) no longer contains the dead row.
    const raw = JSON.parse(
      await readFile(join(TEST_HOME, ".hermetic", "recent-sources.json"), "utf-8")
    );
    expect(raw).toHaveLength(2);
  });

  it("backs up a corrupt index instead of reading it as [] (which the next write would wipe)", async () => {
    const { writeFile, mkdir, readdir, readFile: rf } = await import("node:fs/promises");
    const indexPath = join(TEST_HOME, ".hermetic", "recent-sources.json");
    await mkdir(join(TEST_HOME, ".hermetic"), { recursive: true });
    await writeFile(indexPath, '[{"id":"x","kind":"upload"', "utf-8"); // truncated

    // A corrupt file reads as empty (nothing to show) but is NOT silently lost.
    expect(await loadRecentSources()).toEqual([]);
    const files = await readdir(join(TEST_HOME, ".hermetic"));
    const backup = files.find((f) => /^recent-sources\.json\.corrupt-\d+$/.test(f));
    expect(backup).toBeDefined();
    expect(await rf(join(TEST_HOME, ".hermetic", backup!), "utf-8")).toBe(
      '[{"id":"x","kind":"upload"'
    );
  });

  it("does not record while LLM replay mode is active (CI proofs must not write user state)", async () => {
    const { configureLLMReplay } = await import("@/lib/llm/replay");
    configureLLMReplay({ mode: "replay", dir: "/tmp/none" });
    try {
      await recordRecentSource({
        kind: "remote-parquet",
        name: "should-not-exist",
        subtitle: "s3://x",
        url: "s3://x",
      });
      expect(await loadRecentSources()).toHaveLength(0);
    } finally {
      configureLLMReplay(null);
    }
  });
});
