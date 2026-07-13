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
    await recordRecentSource({
      kind: "local-file",
      name: "raw.parquet",
      subtitle: "/data/raw.parquet",
      path: "/data/raw.parquet",
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
        await recordRecentSource({
          kind: "local-file",
          name: `f${i}`,
          subtitle: `/data/f${i}`,
          path: `/data/f${i}`,
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
