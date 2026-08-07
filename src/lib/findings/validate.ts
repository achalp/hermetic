/**
 * Findings validation — the server-side half of the declared-findings
 * grammar (specs/declared-findings-2026-08-06.md §1/§3).
 *
 * Library-first: pure functions over plain data; no pipeline imports, no
 * I/O. Callers own where issues go (failure log, diagnostics, __grounding).
 *
 * Posture: NOTHING here fails a run. Structurally invalid entries drop
 * with an issue; semantic disagreements (derivation contradictions) KEEP
 * the entry and flag it — caveat, don't rewrite.
 */
import { z } from "zod";
import {
  FINDINGS_MANIFEST_VERSION,
  type FindingEntry,
  type FindingIssue,
  type FindingsManifest,
  type FindingsValidation,
} from "@/lib/contracts/findings";

// ── Structural limits (spec §1, review E10) ──────────────────────────
export const VALUE_MAX_BYTES = 2_048;
export const VALUE_MAX_DEPTH = 2;
export const VALUE_MAX_LEAVES = 25;
export const MANIFEST_MAX_ENTRIES = 100;
export const MANIFEST_MAX_BYTES = 64_000;

/** Bare declared names: no dots — dotted forms are the step namespace. */
export const FINDING_NAME_RE = /^[a-z][a-z0-9_]*$/;
/** Step-qualified reference (investigate): step_N.name, N ≥ 1 (1-based). */
export const STEP_QUALIFIED_RE = /^step_([1-9]\d*)\.([a-z][a-z0-9_]*)$/;

// Content-free meta-schema: every content-bearing field is open vocabulary.
// An enum here would be the fixed taxonomy sneaking back in (spec §0).
const entrySchema = z.object({
  name: z.string().regex(FINDING_NAME_RE),
  definition: z.string().min(8),
  dtype: z.string().min(1),
  unit: z.string().optional(),
  value: z.unknown(),
  derived_from_findings: z.array(z.string()).optional(),
  derived_from_columns: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  method: z.string().optional(),
  code_ref: z.string().optional(),
  redeclarations: z.number().int().nonnegative().optional(),
});

function valueShape(value: unknown): { bytes: number; depth: number; leaves: number } {
  const json = JSON.stringify(value) ?? "null";
  let leaves = 0;
  let maxDepth = 0;
  const walk = (v: unknown, depth: number) => {
    maxDepth = Math.max(maxDepth, depth);
    if (v !== null && typeof v === "object") {
      const entries = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
      for (const item of entries) walk(item, depth + 1);
    } else {
      leaves++;
    }
  };
  walk(value, 0);
  return { bytes: Buffer.byteLength(json, "utf-8"), depth: maxDepth, leaves };
}

/**
 * Validate raw declarations (already merged last-wins by the caller or by
 * mergeDeclarations below) into a clean manifest + issues. `referenceNames`
 * is the definition-anchor set: source-schema columns ∪ derived-frame
 * columns ∪ (investigate) upstream finding names — a definition mentioning
 * none of them is unanchored (advisory drop is too strong: FLAG only,
 * since derived vocabulary can legitimately lead the schema).
 */
export function validateFindings(
  entries: unknown[],
  opts: { referenceNames?: string[] } = {}
): FindingsValidation {
  const issues: FindingIssue[] = [];
  const clean: FindingEntry[] = [];
  let dropped = 0;

  for (const raw of entries) {
    const parsed = entrySchema.safeParse(raw);
    if (!parsed.success) {
      dropped++;
      issues.push({
        kind: "meta_schema",
        name:
          typeof (raw as { name?: unknown })?.name === "string"
            ? ((raw as { name: string }).name ?? undefined)
            : undefined,
        detail: parsed.error.issues[0]?.message ?? "invalid entry",
      });
      continue;
    }
    const entry = parsed.data as FindingEntry;

    const shape = valueShape(entry.value);
    if (
      shape.bytes > VALUE_MAX_BYTES ||
      shape.depth > VALUE_MAX_DEPTH ||
      shape.leaves > VALUE_MAX_LEAVES
    ) {
      dropped++;
      issues.push({
        kind: "value_too_large",
        name: entry.name,
        detail: `value ${shape.bytes}B/depth ${shape.depth}/leaves ${shape.leaves} exceeds ${VALUE_MAX_BYTES}B/${VALUE_MAX_DEPTH}/${VALUE_MAX_LEAVES}`,
      });
      continue;
    }

    // Definition anchoring (advisory): must mention a known column/measure.
    const refs = opts.referenceNames ?? [];
    if (refs.length > 0) {
      const def = entry.definition.toLowerCase();
      const anchored = refs.some((r) => r && def.includes(r.toLowerCase()));
      if (!anchored) {
        issues.push({
          kind: "definition_unanchored",
          name: entry.name,
          detail: "definition references no known column or declared measure",
        });
      }
    }
    clean.push(entry);
  }

  // Manifest-level caps: drop largest-first beyond entry/byte budget.
  let kept = clean;
  if (kept.length > MANIFEST_MAX_ENTRIES) {
    const sorted = [...kept].sort((a, b) => valueShape(a.value).bytes - valueShape(b.value).bytes);
    const removed = sorted.slice(MANIFEST_MAX_ENTRIES);
    kept = sorted.slice(0, MANIFEST_MAX_ENTRIES);
    dropped += removed.length;
    issues.push({
      kind: "manifest_truncated",
      detail: `entry cap: dropped ${removed.length} largest entries (${removed.map((e) => e.name).join(", ")})`,
    });
  }
  while (kept.length > 0 && Buffer.byteLength(JSON.stringify(kept), "utf-8") > MANIFEST_MAX_BYTES) {
    const idx = kept.reduce(
      (imax, e, i) => (valueShape(e.value).bytes > valueShape(kept[imax].value).bytes ? i : imax),
      0
    );
    const [removed] = kept.splice(idx, 1);
    dropped++;
    issues.push({
      kind: "manifest_truncated",
      name: removed.name,
      detail: "byte cap: dropped largest entry",
    });
  }

  return {
    manifest: { manifest_version: FINDINGS_MANIFEST_VERSION, findings: kept },
    issues,
    droppedCount: dropped,
  };
}

/**
 * Last-wins merge of raw declaration order (the sidecar is append-ordered):
 * a re-declared name keeps the LAST entry with a `redeclarations` counter
 * (spec §2.3 — refined redeclarations are the better entry; the counter
 * makes loop-abuse visible to the audit layer).
 */
export function mergeDeclarations(ordered: FindingEntry[]): FindingEntry[] {
  const byName = new Map<string, FindingEntry>();
  const counts = new Map<string, number>();
  for (const entry of ordered) {
    counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
    byName.set(entry.name, entry);
  }
  return [...byName.values()].map((e) => {
    const n = (counts.get(e.name) ?? 1) - 1;
    return n > 0 ? { ...e, redeclarations: n } : { ...e, redeclarations: 0 };
  });
}
