import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableDuckDbBundles } from "@/lib/sandbox/wasm/host-duckdb";

/**
 * The .mcpb vendors the eh bundle ONLY (the 41 MB mvp module is a fallback no
 * supported Node needs) — these pin that a pruned dist still boots and a
 * truncated one fails loudly at the boundary, not as a cryptic instantiate
 * error mid-connect.
 */
function distWith(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "duckdb-dist-"));
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), "x");
  return dir;
}

describe("availableDuckDbBundles", () => {
  it("a full dist offers eh first, then mvp", () => {
    const dir = distWith([
      "duckdb-eh.wasm",
      "duckdb-node-eh.worker.cjs",
      "duckdb-mvp.wasm",
      "duckdb-node-mvp.worker.cjs",
    ]);
    expect(Object.keys(availableDuckDbBundles(dir))).toEqual(["eh", "mvp"]);
  });

  it("an eh-only dist (the .mcpb prune) is complete", () => {
    const dir = distWith(["duckdb-eh.wasm", "duckdb-node-eh.worker.cjs"]);
    const bundles = availableDuckDbBundles(dir);
    expect(Object.keys(bundles)).toEqual(["eh"]);
    expect(bundles.eh!.mainWorker.endsWith("duckdb-node-eh.worker.cjs")).toBe(true);
  });

  it("a dist with NO bundle throws a named, actionable error", () => {
    const dir = distWith(["README.md"]);
    expect(() => availableDuckDbBundles(dir)).toThrow(/missing or truncated/);
  });
});
