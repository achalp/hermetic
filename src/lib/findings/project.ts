/**
 * Composer projection + namespacing (spec §4.1, §7.1).
 *
 * The projection is the ONLY shape the values-blind composer may receive:
 * values stripped (leaf field NAMES retained — the precedented exposure
 * class), definitions numeral-scrubbed as the second layer behind the
 * literal-only rule (a literal definition should contain no data-derived
 * numbers; scrubbing costs nothing when it's clean).
 */
import type { FindingEntry, FindingProjection } from "@/lib/contracts/findings";

/** Prompt budget for the projection block (spec §4.1). */
export const PROJECTION_MAX_BYTES = 8_000;

/** Years survive ("2024 revenue" is vocabulary, not a leak); other digit
 *  runs become ⟨n⟩. */
export function scrubNumerals(text: string): string {
  return text.replace(/\d[\d,.]*/g, (m) => {
    const clean = m.replace(/[.,]$/, "");
    return /^(19|20)\d{2}$/.test(clean) ? m : "⟨n⟩";
  });
}

function leafFields(value: unknown): string[] | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  // Null-valued leaves are EXCLUDED: a values-blind composer that sees a
  // field name will bind it, the null then gets refused, the sentence
  // stripped, and a repair pass burned — making null bindings impossible
  // at the projection beats refusing them at the resolver (run-24).
  // BOOLEAN leaves are excluded for the same reason (spec
  // finding-field-roles §2.M2): a flag has no word for a sentence slot —
  // "spend shares sum to Yes" — and the planner cannot bind what it is
  // never offered. Flags are stated in words or branched on host-side;
  // validatePlan rejects a boolean binding as the enforcing layer.
  const keys = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "boolean")
    .map(([k]) => k);
  return keys.length > 0 ? keys : undefined;
}

/**
 * The field(s) that carry a claim's ACTUAL result, per dtype. All null ⇒ the
 * analysis ran and found nothing — a non-detection, not a small effect.
 *
 * Why this exists (run 77051c9d): leafFields drops null leaves, so a
 * step_change that detected nothing projected as
 * `{name: daily_spend_step_change, value_fields: ["baseline_spread"]}` —
 * a bindable number sitting under a definition promising "the largest
 * period-over-period jump that stands out and persists". The planner did the
 * only thing that shape invites and wrote "The sharpest jump between
 * consecutive days measured 118.97", where 118.97 is baseline_spread, a SCALE
 * REFERENCE. Every gate passed: the digit was a binding, the ref resolved, the
 * field was real and non-null. Binding discipline proves a number is real; it
 * cannot prove the sentence around it means the right thing.
 *
 * So the projection now says the quiet part: `detected: false`, and no
 * value_fields at all. The planner cannot misuse a number it never receives,
 * and the realizer's own template already narrates non-detection correctly.
 *
 * DEMOTED (spec finding-field-roles-2026-08-13 §2.M3): the claim functions
 * now declare `"detected": False` in the value itself on their null-result
 * branches, and isNonDetection reads that first. This table remains ONLY as
 * the fallback for legacy envelopes recorded before the key existed — every
 * run on disk at the time of the change. Do not extend it for new dtypes;
 * declare the property at the producer instead.
 */
const PRIMARY_RESULT_FIELDS: Record<string, string[]> = {
  step_change: ["period", "delta"],
  superlative: ["period", "value"],
  direction: ["direction"],
  trend: ["direction", "slope_per_period"],
  current_state: ["period", "value"],
  comparison: ["early_median", "late_median"],
  correlation: ["coefficient"],
  attribution: ["leader_early", "leader_late"],
  heterogeneity: ["significant"],
  share: ["shares_pct"],
  distribution: ["median"],
  decomposition: ["components"],
};

/** True when the claim reports a non-detection — the analysis LOOKED and
 *  found nothing (no step change, no peak, no correlation).
 *
 *  Two tiers (spec finding-field-roles-2026-08-13 §2.M3):
 *   1. PRODUCER-DECLARED: the claim function set `"detected": false` in the
 *      value on its null-result branch. This is data, so it survives
 *      to_native, {**spread}, JSON, and investigate namespacing — the
 *      transport a metadata side-channel could never guarantee.
 *   2. LEGACY FALLBACK (demoted, kept for every envelope predating the
 *      key): all of the dtype's primary result fields are null. This
 *      host-side table re-derives what the producer knows and exists ONLY
 *      for old records; new claims should never need it.
 *  Unknown dtypes without the declared key never qualify (a dtype we have
 *  no primary map for must not be silently blanked). */
export function isNonDetection(entry: FindingEntry): boolean {
  const v = entry.value;
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  if (obj.detected === false) return true;
  const primary = PRIMARY_RESULT_FIELDS[entry.dtype];
  if (!primary) return false;
  // Only claims that actually CARRY these fields can be non-detections; a
  // value shaped nothing like the map is a different claim, not an empty one.
  const present = primary.filter((k) => k in obj);
  if (present.length === 0) return false;
  return present.every((k) => obj[k] === null || obj[k] === undefined);
}

export function projectFinding(entry: FindingEntry): FindingProjection {
  const nonDetection = isNonDetection(entry);
  const fields = nonDetection ? undefined : leafFields(entry.value);
  return {
    name: entry.name,
    definition: scrubNumerals(entry.definition),
    dtype: entry.dtype,
    ...(entry.unit ? { unit: entry.unit } : {}),
    ...(fields ? { value_fields: fields } : {}),
    ...(nonDetection ? { detected: false as const } : {}),
    ...(entry.tags?.length ? { tags: entry.tags } : {}),
  };
}

/**
 * Budgeted projection for prompt injection: WHOLE entries only (a half
 * definition is worse than an omission), untagged dropped first then
 * largest, with the omitted names reported so the ignored-findings check
 * doesn't fire on entries the composer never saw.
 */
export function projectManifestForPrompt(findings: FindingEntry[]): {
  projections: FindingProjection[];
  omitted: string[];
} {
  const projections = findings.map(projectFinding);
  const size = (list: FindingProjection[]) => Buffer.byteLength(JSON.stringify(list), "utf-8");
  if (size(projections) <= PROJECTION_MAX_BYTES) return { projections, omitted: [] };

  // Priority: tagged before untagged; then smaller before larger.
  const prioritized = [...projections].sort((a, b) => {
    const tagRank = (p: FindingProjection) => (p.tags?.length ? 0 : 1);
    if (tagRank(a) !== tagRank(b)) return tagRank(a) - tagRank(b);
    return JSON.stringify(a).length - JSON.stringify(b).length;
  });
  const kept: FindingProjection[] = [];
  const omitted: string[] = [];
  for (const p of prioritized) {
    if (size([...kept, p]) <= PROJECTION_MAX_BYTES) kept.push(p);
    else omitted.push(p.name);
  }
  // Restore declaration order for the prompt (stable narrative ordering).
  const order = new Map(projections.map((p, i) => [p.name, i]));
  kept.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
  return { projections: kept, omitted };
}

/** Investigate merge: prefix each step's findings into the run namespace. */
export function namespaceFindings(stepNo: number, findings: FindingEntry[]): FindingEntry[] {
  return findings.map((f) => ({
    ...f,
    name: `step_${stepNo}.${f.name}`,
    derived_from_findings: f.derived_from_findings?.map((ref) =>
      ref.includes(".") ? ref : `step_${stepNo}.${ref}`
    ),
  }));
}
