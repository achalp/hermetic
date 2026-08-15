/**
 * Orphan-sweep cross-process safety (finding M11). The scratch dir is SHARED
 * by the web and MCP harnesses; each only knows its own in-memory sources. The
 * sweep must therefore treat a file referenced by ANY sibling on-disk index as
 * live — deleting a sibling's retained upload produced "CSV not found,
 * re-upload" for a dataset the user never let go of.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, utimes, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setPathRoots, hermeticPaths } from "@/lib/paths";
import { sweepExpiredCSVStore } from "@/lib/csv/storage";

let dir: string;
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false
  );
const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

async function ageOrphan(path: string, content = "a,b\n1,2\n") {
  await writeFile(path, content, "utf-8");
  await utimes(path, THIRTY_DAYS_AGO, THIRTY_DAYS_AGO); // well past the 7-day gate
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hermetic-sweep-"));
  setPathRoots({
    dataRoot: join(dir, "data"),
    scratchRoot: join(dir, "scratch"),
    userRoot: join(dir, "user"),
  });
  await mkdir(hermeticPaths.scratchDir(), { recursive: true });
  await mkdir(hermeticPaths.dataDir(), { recursive: true });
});

afterEach(async () => {
  setPathRoots({});
  await rm(dir, { recursive: true, force: true });
});

describe("sweepExpiredCSVStore — cross-process orphan safety", () => {
  it("does NOT delete an aged scratch file that a sibling mcp-sources.json still references", async () => {
    const scratch = hermeticPaths.scratchDir();
    const live = join(scratch, "sibling-live.csv"); // owned by the OTHER harness
    const dead = join(scratch, "truly-orphaned.csv"); // in no index at all
    await ageOrphan(live);
    await ageOrphan(dead);

    // The MCP harness persisted this source; its bytes live at `live`.
    await writeFile(
      join(hermeticPaths.dataDir(), "mcp-sources.json"),
      JSON.stringify([{ id: "s1", csvId: "c1", stored: { filePath: live }, savedAt: Date.now() }]),
      "utf-8"
    );

    const res = await sweepExpiredCSVStore();

    expect(await exists(live)).toBe(true); // the sibling's live upload survived
    expect(await exists(dead)).toBe(false); // the genuine orphan was reclaimed
    expect(res.orphans).toBe(1);
  });

  it("also respects a path referenced by the recent-sources index", async () => {
    const scratch = hermeticPaths.scratchDir();
    const live = join(scratch, "recent-live.csv");
    await ageOrphan(live);
    await mkdir(join(dir, "user"), { recursive: true });
    await writeFile(
      hermeticPaths.recentSourcesFile(),
      JSON.stringify([{ id: "r1", kind: "upload", path: live }]),
      "utf-8"
    );

    await sweepExpiredCSVStore();
    expect(await exists(live)).toBe(true);
  });

  it("a corrupt sibling index doesn't crash the sweep (contributes no references)", async () => {
    const scratch = hermeticPaths.scratchDir();
    const dead = join(scratch, "orphan.csv");
    await ageOrphan(dead);
    await writeFile(join(hermeticPaths.dataDir(), "mcp-sources.json"), "{ truncated", "utf-8");

    const res = await sweepExpiredCSVStore();
    expect(res.orphans).toBe(1); // swept normally; the unreadable index is ignored
    expect(await exists(dead)).toBe(false);
  });
});
