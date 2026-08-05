/**
 * NDJSON patch-line parsing and the run-error read, shared by every consumer
 * of an accumulated patch stream (CLI harness, MCP analyze, disconnect
 * history-save). The trim / `:`-comment-skip / JSON.parse-catch loop was
 * copied in four places, and the CLI detected failure by substring-matching
 * serialized JSON key order — one implementation now, next to assemble-spec.
 */
import type { PatchLike } from "./computed-key-audit";

/**
 * Parse raw emitted chunks into patches. Chunks may carry several lines;
 * keepalive comments (`: keepalive`) and non-JSON noise are skipped.
 */
export function parsePatchLines(lines: string[]): PatchLike[] {
  const patches: PatchLike[] = [];
  for (const chunk of lines) {
    for (const raw of chunk.split("\n")) {
      const t = raw.trim();
      if (!t || t.startsWith(":")) continue; // keepalive comment
      try {
        patches.push(JSON.parse(t));
      } catch {
        // non-JSON line (progress noise) — skip
      }
    }
  }
  return patches;
}

/**
 * The run's terminal error, or null. `/state/__error` (the typed channel in
 * contracts/stream-state) carries the real message from both pipelines; a
 * bare root="error" spec without it still reports as a failure so no
 * producer drift can make an errored run look successful.
 */
export function readRunError(patches: PatchLike[]): string | null {
  const errorPatch = patches.find((p) => p?.path === "/state/__error");
  if (typeof errorPatch?.value === "string" && errorPatch.value) return errorPatch.value;
  const rootError = patches.some((p) => p?.path === "/root" && p.value === "error");
  return rootError ? "Analysis failed (no error detail was emitted)." : null;
}
