/**
 * Declared-findings contract (specs/declared-findings-2026-08-06.md §1).
 *
 * TYPES ONLY — contracts must not import from pipeline or carry logic (the
 * zod meta-schema and all validation live in lib/findings). The manifest is
 * an ENVELOPE with a version: the grammar (this shape) is the stable
 * machine contract; the vocabulary (dtype/tags/units values) is open by
 * design — consumers may rely on structure, never on a dtype enum.
 */

export const FINDINGS_MANIFEST_VERSION = "1.0";

export interface FindingEntry {
  /** ^[a-z][a-z0-9_]*$ — no dots (reserved for step namespacing). Unique
   *  within its declaring script run; investigate uniqueness is DERIVED
   *  via `step_N.<name>` namespacing, never declared. */
  name: string;
  /** Literal-only at the call site (values-leak guard); must reference at
   *  least one actual column or declared measure. */
  definition: string;
  /** OPEN vocabulary ("scalar", "shares", "direction", ... are conventions). */
  dtype: string;
  /** Optional, open; "pp"/"pct" naming conventions apply. */
  unit?: string;
  /** ≤2KB serialized, depth ≤2, ≤25 leaf fields (lib/findings enforces). */
  value: unknown;
  /** Finding names this derives from (step-qualified in investigate). */
  derived_from_findings?: string[];
  /** Source/derived-frame column names this derives from. */
  derived_from_columns?: string[];
  /** OPEN vocabulary; well-known tags unlock generic affordances. */
  tags?: string[];
  /** Literal-only at the call site. */
  method?: string;
  /** Auto-captured, generated-code-relative: "script.py:<line>". */
  code_ref?: string;
  /** How many times this name was re-declared (last-wins merge). */
  redeclarations?: number;
}

export interface FindingsManifest {
  manifest_version: string;
  findings: FindingEntry[];
}

/** One dropped/flagged declaration — failure-log & diagnostics food. */
export interface FindingIssue {
  /** Machine class, e.g. "meta_schema", "literal_rule", "value_too_large",
   *  "derivation_missing", "derivation_contradiction", "definition_unanchored",
   *  "unresolved_lineage", "manifest_truncated". */
  kind: string;
  /** The finding name involved (when known). */
  name?: string;
  detail: string;
}

/** Validation output: the clean manifest plus everything that was flagged. */
export interface FindingsValidation {
  manifest: FindingsManifest;
  issues: FindingIssue[];
  /** Entries dropped outright (meta-schema / limits), for diagnostics. */
  droppedCount: number;
}

/**
 * The composer-facing projection: NO values, definitions numeral-scrubbed.
 * Field names of structured values are retained (same exposure class as
 * result keys — see spec §1 privacy boundary).
 */
export interface FindingProjection {
  name: string;
  definition: string;
  dtype: string;
  unit?: string;
  /** Leaf field names for structured values (so the composer can bind
   *  `$finding:name.field` without seeing values). */
  value_fields?: string[];
  /** Present and false when the claim's PRIMARY fields are all null — the
   *  analysis looked and found nothing (no step change, no peak, no
   *  correlation). Secondary fields are withheld in that case, so there is
   *  no number left to narrate the non-event with. See projectFinding. */
  detected?: false;
  tags?: string[];
}

/** Rollout mode (spec §8) — lives in runtime-config, shared by all harnesses. */
export type FindingsMode = "off" | "shadow" | "on";
