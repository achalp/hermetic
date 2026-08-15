/**
 * Crash-safe JSON primitives (finding 07). The invariants that matter:
 *   - a failed write leaves the existing file intact and no temp leftover;
 *   - a missing file reads as undefined (the normal empty state);
 *   - a genuinely corrupt file is BACKED UP (never silently emptied);
 *   - a transient read error PROPAGATES and never renames the only copy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeFileAtomic,
  writeJsonFileAtomic,
  readJsonFile,
  backupCorruptFile,
} from "@/lib/json-file";
import { logger } from "@/lib/logger";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hermetic-jsonfile-"));
  vi.spyOn(logger, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("writeJsonFileAtomic / writeFileAtomic", () => {
  it("round-trips through readJsonFile and creates the parent dir", async () => {
    const path = join(dir, "nested", "a.json");
    await writeJsonFileAtomic(path, { hello: "world", n: 1 });
    expect(await readJsonFile(path)).toEqual({ hello: "world", n: 1 });
  });

  it("leaves no partial file and no temp leftover when the rename fails", async () => {
    // Force rename(2) to fail by making the target an existing directory:
    // the temp file writes fine, the rename onto a dir throws (EISDIR).
    const path = join(dir, "target");
    await mkdir(path, { recursive: true });
    await expect(writeFileAtomic(path, "payload")).rejects.toThrow();
    // The directory (the "existing file") is untouched...
    expect((await stat(path)).isDirectory()).toBe(true);
    // ...and the scratch temp was cleaned up — no .tmp-* debris remains.
    const leftovers = (await readdir(dir)).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("uses a uniquely-suffixed temp (concurrent writes to one path don't collide)", async () => {
    const path = join(dir, "concurrent.json");
    await Promise.all([
      writeJsonFileAtomic(path, { who: "a" }),
      writeJsonFileAtomic(path, { who: "b" }),
    ]);
    // Whichever landed last, the file is a WHOLE valid JSON object (never a
    // torn interleave), and no temp files survive.
    const parsed = await readJsonFile<{ who: string }>(path);
    expect(["a", "b"]).toContain(parsed?.who);
    expect((await readdir(dir)).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });
});

describe("readJsonFile", () => {
  it("returns undefined for a missing file (ENOENT), no backup, no warn", async () => {
    const path = join(dir, "missing.json");
    expect(await readJsonFile(path)).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it("backs up a corrupt file to .corrupt-<ts>, returns undefined, preserves bytes", async () => {
    const path = join(dir, "bad.json");
    await writeFile(path, "{ not json at all", "utf-8");
    const onCorrupt = vi.fn();
    expect(await readJsonFile(path, { onCorrupt })).toBeUndefined();

    const files = await readdir(dir);
    const backup = files.find((f) => /^bad\.json\.corrupt-\d+$/.test(f));
    expect(backup).toBeDefined();
    // The only copy survived, byte for byte.
    expect(await readFile(join(dir, backup!), "utf-8")).toBe("{ not json at all");
    expect(onCorrupt).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("treats a parsed-but-wrong-shape file as corrupt when validate fails", async () => {
    const path = join(dir, "obj.json");
    await writeFile(path, JSON.stringify({ not: "an array" }), "utf-8");
    const result = await readJsonFile(path, {
      validate: (p): p is unknown[] => Array.isArray(p),
    });
    expect(result).toBeUndefined();
    const backup = (await readdir(dir)).find((f) => /^obj\.json\.corrupt-\d+$/.test(f));
    expect(backup).toBeDefined();
  });

  it("does NOT back up on a transient read error — it rethrows, leaving the file", async () => {
    // A directory in place of a file makes readFile throw EISDIR (a transient,
    // non-ENOENT error): the only copy must NOT be renamed away.
    const path = join(dir, "adir");
    await mkdir(path, { recursive: true });
    await expect(readJsonFile(path)).rejects.toThrow();
    // No .corrupt- backup was invented, and the entry is still the directory.
    expect((await readdir(dir)).some((f) => f.includes(".corrupt-"))).toBe(false);
    expect((await stat(path)).isDirectory()).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("backupCorruptFile", () => {
  it("renames the file out of the way and returns the backup path", async () => {
    const path = join(dir, "x.json");
    await writeFile(path, "garbage", "utf-8");
    const backup = await backupCorruptFile(path);
    expect(backup).toMatch(/x\.json\.corrupt-\d+$/);
    expect(await readFile(backup!, "utf-8")).toBe("garbage");
  });

  it("returns undefined (no throw) when the file cannot be renamed", async () => {
    expect(await backupCorruptFile(join(dir, "never-existed.json"))).toBeUndefined();
  });
});
