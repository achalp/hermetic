/**
 * tar-stage: the batched-staging archive must be a REAL tar — validated by
 * extracting with the system `tar` and comparing bytes — because a subtly
 * malformed header would corrupt every staged sandbox file at once (perf P2).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTarArchive, listTarEntryNames } from "@/lib/sandbox/tar-stage";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hermetic-tar-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const FILES = [
  { path: "/data/input.csv", content: "a,b\n1,2\n" },
  { path: "/data/script.py", content: "print('hi')\n# unicode: héllo → ✓\n" },
  // >512 bytes so the content spans multiple blocks and padding is exercised.
  { path: "/data/hermetic_runtime/findings.py", content: "x = 1\n".repeat(1000) },
  { path: "/data/hermetic_runtime/sub/deep.py", content: "" }, // empty file
];

describe("buildTarArchive", () => {
  it("extracts with system tar to byte-identical files (incl. nested dirs, empty, unicode)", () => {
    const archive = buildTarArchive(FILES);
    const tarPath = join(dir, "stage.tar");
    writeFileSync(tarPath, archive);
    execFileSync("tar", ["-xf", tarPath, "-C", dir]);
    for (const f of FILES) {
      const extracted = readFileSync(join(dir, f.path.slice("/data/".length)));
      expect(extracted.equals(Buffer.from(f.content, "utf-8")), f.path).toBe(true);
    }
  });

  it("lists exactly the expected entries (dirs first, then files)", () => {
    const names = listTarEntryNames(buildTarArchive(FILES));
    expect(names).toEqual([
      "hermetic_runtime/",
      "hermetic_runtime/sub/",
      "input.csv",
      "script.py",
      "hermetic_runtime/findings.py",
      "hermetic_runtime/sub/deep.py",
    ]);
  });

  it("is deterministic (same input → same bytes)", () => {
    expect(buildTarArchive(FILES).equals(buildTarArchive(FILES))).toBe(true);
  });

  it("rejects paths outside /data, traversal, over-long and non-ASCII names", () => {
    expect(() => buildTarArchive([{ path: "/etc/passwd", content: "x" }])).toThrow(/\/data\//);
    expect(() => buildTarArchive([{ path: "/data/../x", content: "x" }])).toThrow(/unsafe/);
    expect(() => buildTarArchive([{ path: "/data/" + "a".repeat(120), content: "x" }])).toThrow(
      /too long/
    );
    expect(() => buildTarArchive([{ path: "/data/héllo.py", content: "x" }])).toThrow(/ASCII/);
  });
});
