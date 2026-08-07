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
  const keys = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k]) => k);
  return keys.length > 0 ? keys : undefined;
}

export function projectFinding(entry: FindingEntry): FindingProjection {
  return {
    name: entry.name,
    definition: scrubNumerals(entry.definition),
    dtype: entry.dtype,
    ...(entry.unit ? { unit: entry.unit } : {}),
    ...(leafFields(entry.value) ? { value_fields: leafFields(entry.value) } : {}),
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
