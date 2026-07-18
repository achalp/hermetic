/**
 * History cap enforcement (API-9): prune-on-save keeps the newest
 * HERMETIC_MAX_HISTORY_ENTRIES entries and deletes the rest. fs/promises is
 * mocked with an in-memory directory map so the tests never touch
 * data/history/.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";

// In-memory "disk": entryId → meta.json content.
const entries = new Map<string, string>();
const removed: string[] = [];

vi.mock("fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  readFile: vi.fn(async (path: string) => {
    const m = /history\/([^/]+)\/meta\.json$/.exec(String(path));
    const content = m && entries.get(m[1]);
    if (!content) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    return content;
  }),
  readdir: vi.fn(async () =>
    [...entries.keys()].map((name) => ({ name, isDirectory: () => true }))
  ),
  rm: vi.fn(async (path: string) => {
    const m = /history\/([^/]+)$/.exec(String(path));
    if (m) {
      entries.delete(m[1]);
      removed.push(m[1]);
    }
  }),
}));

import { pruneHistory, listHistory } from "@/lib/history/storage";

const addEntry = (timestamp: number): string => {
  const id = randomUUID();
  entries.set(id, JSON.stringify({ id, question: `q@${timestamp}`, timestamp }));
  return id;
};

beforeEach(() => {
  entries.clear();
  removed.length = 0;
});

afterEach(() => {
  delete process.env.HERMETIC_MAX_HISTORY_ENTRIES;
});

describe("pruneHistory", () => {
  it("deletes the oldest entries beyond the cap, newest kept", async () => {
    const ids = [addEntry(1000), addEntry(2000), addEntry(3000), addEntry(4000), addEntry(5000)];
    const pruned = await pruneHistory(3);
    expect(pruned).toBe(2);
    // The two OLDEST are gone; the three newest survive.
    expect(removed.sort()).toEqual([ids[0], ids[1]].sort());
    expect((await listHistory()).map((m) => m.timestamp)).toEqual([5000, 4000, 3000]);
  });

  it("no-ops under the cap and on a nonsensical cap", async () => {
    addEntry(1000);
    addEntry(2000);
    expect(await pruneHistory(5)).toBe(0);
    expect(await pruneHistory(0)).toBe(0);
    expect(await pruneHistory(Number.NaN)).toBe(0);
    expect(entries.size).toBe(2);
  });

  it("reads the cap from HERMETIC_MAX_HISTORY_ENTRIES", async () => {
    process.env.HERMETIC_MAX_HISTORY_ENTRIES = "2";
    for (const ts of [1, 2, 3, 4]) addEntry(ts);
    expect(await pruneHistory()).toBe(2);
    expect((await listHistory()).map((m) => m.timestamp)).toEqual([4, 3]);
  });

  it("skips corrupted entries without stranding the rest", async () => {
    addEntry(1000);
    addEntry(2000);
    const corrupt = randomUUID();
    entries.set(corrupt, "not json{");
    // Corrupt meta is invisible to listHistory → never selected for pruning,
    // and the valid entries still prune correctly around it.
    expect(await pruneHistory(1)).toBe(1);
    expect(removed).toHaveLength(1);
    expect(entries.has(corrupt)).toBe(true);
  });
});
