/**
 * Lesson fingerprinting — the ledger's dedup identity. Two runs failing the
 * same way must land on ONE ledger entry with two evidence rows, so the
 * signature normalizes away the run-specific noise (numbers, paths, quoted
 * values) and keeps the failure's shape.
 */
import { createHash } from "node:crypto";

/** Normalize an error head into a stable signature. */
export function normalizeError(errorText: string): string {
  return (
    errorText
      .split("\n")
      // Keep the semantically dense lines: the exception/final message and
      // any engine suggestion; drop traceback frames (paths + line numbers).
      .filter((l) => !/^\s*(File |Traceback|\s*\^+\s*$)/.test(l))
      .join(" ")
      .toLowerCase()
      // Run-specific noise → placeholders.
      .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, "'…'") // quoted strings
      .replace(/\/[^\s]+/g, "/…") // paths
      .replace(/\b\d+(\.\d+)?\b/g, "N") // numbers
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300)
  );
}

export function lessonFingerprint(input: {
  kind: string;
  parentSkill?: string;
  errorText: string;
}): string {
  const sig = normalizeError(input.errorText);
  return createHash("sha256")
    .update(`${input.kind}|${input.parentSkill ?? ""}|${sig}`)
    .digest("hex")
    .slice(0, 16);
}

/** Structure-only schema identity for exemplar dedup/retrieval. */
export function schemaFingerprint(columns: Array<{ name: string; dtype: string }>): string {
  const shape = columns
    .map((c) => `${c.name}:${c.dtype}`)
    .sort()
    .join(",");
  return createHash("sha256").update(shape).digest("hex").slice(0, 16);
}
