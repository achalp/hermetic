/**
 * Shared prompt fragments for the placeholder-grounding invariant.
 *
 * Every composer (single-shot dashboard, investigate, per-step notebook
 * cell) feeds its output through ONE resolver — resolve-placeholders.ts —
 * so the prompt-side contract of that resolver is a single invariant:
 *
 *   - $result / $chartData placeholders are JSON STRING values, never the
 *     object form ({"$result": ...} does not resolve);
 *   - prose must NEVER state a literal number — every figure must be a
 *     $result placeholder so it resolves to a value the analysis computed.
 *
 * The invariant is stated here ONCE and interpolated into all three
 * composers. Each composer's genuinely-different parts (step_N_-prefixed
 * vs unprefixed keys, which components are named, the fallback wording)
 * are parameters, NOT copies.
 *
 * BYTE-IDENTITY CONSTRAINT: the record/replay layer (replay.ts) hashes the
 * exact request content, so scripts/golden and test-spec fixtures key on
 * these prompt strings byte-for-byte. The fragments below therefore
 * reproduce each composer's historical wording EXACTLY — including the
 * places where the wording drifted apart (the METADATA_* rules keep the
 * single-shot composer's phrasing). Unifying the wording across composers
 * is a deliberate follow-up that requires re-recording the fixtures.
 */

// ── The prose-number invariant (parameterized) ───────────────────────

export interface NoLiteralNumberRuleOpts {
  /** What a prose number is called in this composer (e.g. "figure", "figure in the insight"). */
  figure: string;
  /** The placeholder key shape shown to the model (e.g. "$result:<key>", "$result:step_N_<key>"). */
  placeholder: string;
  /** Optional clause finishing "…MUST be a <placeholder> placeholder<clause>." */
  clause?: string;
  /** What to do when a number cannot be expressed as a placeholder. */
  fallback: string;
}

/**
 * "NEVER write a literal number in prose" — the grounding half of the
 * invariant, in each composer's exact historical wording.
 */
export function noLiteralNumberRule(opts: NoLiteralNumberRuleOpts): string {
  return `NEVER write a literal number in prose. Every ${opts.figure} MUST be a ${opts.placeholder} placeholder${opts.clause ?? ""}. ${opts.fallback}`;
}

// ── The string-form invariant ────────────────────────────────────────

/**
 * Placeholders are JSON strings, never the object form. Stated explicitly
 * in the step-cell composer; the dashboard composers convey it by example
 * (see RESULT_PLACEHOLDER_USAGE / CHART_DATA_STRING_USAGE below).
 */
export const PLACEHOLDER_STRING_FORM_RULE = `Placeholders are JSON STRING values. Write "value": "$result:total_revenue" and "data": "$chartData:monthly_trend". NEVER use object form — {"$result": "total_revenue"} and {"$chartData": "monthly_trend"} are WRONG and will not resolve.`;

// ── Placeholder usage lines (parameterized: prefixed vs unprefixed) ──

/** `Use "$result:<key>" for scalar values…` — investigate/step-cell user prompts. */
export function resultPlaceholderLine(
  opts: { components?: string; keyNote?: string } = {}
): string {
  return `Use "$result:<key>" for scalar values${opts.components ?? ""}.${opts.keyNote ?? ""}`;
}

/** `Use "$chartData:<key>" for chart data props.` — investigate/step-cell user prompts. */
export function chartDataPlaceholderLine(opts: { keyNote?: string } = {}): string {
  return `Use "$chartData:<key>" for chart data props.${opts.keyNote ?? ""}`;
}

// ── Single-shot dashboard composer's wording (verbatim) ──────────────

/** Metadata-mode $result usage, single-shot user prompt (dashboard-compose). */
export const RESULT_PLACEHOLDER_USAGE = `Use "$result:<key>" placeholders for all scalar values in StatCard, TrendIndicator, and similar components. Example: {"value": "$result:total_sales"}. Supports dot-notation for nested keys: "$result:summary.avg_price".`;

/** Static (no-DataController) $chartData usage, single-shot user prompt. */
export const CHART_DATA_STRING_USAGE = `When referencing chart data in component props, use the string "$chartData:<key>" as the data value. It will be replaced with the actual array at render time. For example: "data": "$chartData:bar_data"`;

/**
 * Narrative grounding rules (grounded-narrative spec, 2026-08-06): the
 * composer must never ASSERT what it cannot SEE. In metadata mode it sees no
 * values at all, so a typed-out number is a fabrication and a direction word
 * is a guess anchored to the question's framing — both are the exact failure
 * this block exists to prevent. Placeholders resolve inline inside prose
 * (resolve-placeholders.ts pass 2), so binding a direction WORD works:
 * "Churn is $result:churn_trend_direction over the year" renders with the
 * computed word.
 */
export const NARRATIVE_GROUNDING_RULES = `## Narrative Grounding (NON-NEGOTIABLE)
Every factual claim in TextBlock/Annotation content and StatCard descriptions must be BOUND to a computed result, never asserted from expectation:
- NUMBERS: always "$result:<key>" (inline placeholders resolve mid-sentence). NEVER type a numeric value into narrative text yourself.
- DIRECTION / TREND words (rising, falling, grew, declined, accelerating, flat...): never write one as a literal. Bind the word itself from a computed key — e.g. "Churn is $result:churn_rate_trend_direction across 2024" — or select phrasing with {"$cond": {...}, "$then": "...", "$else": "..."} on a computed boolean. If no computed key supports the claim, do not make it: describe what the chart shows structurally ("monthly churn rate by segment, below") without asserting a direction.
- SUPERLATIVES (highest, peak, worst, top): only via peak_/top_/... result keys, with the value bound.
- ATTRIBUTION: when the results include a decomposition (…_from_rate / …_from_volume / …_from_mix style keys), any "primarily driven by / attributable to" sentence MUST follow the decomposition's dominant term with its share bound — never a categorical flag that sits beside it. If a flag and a decomposition could disagree, the decomposition wins.
- ANSWER PLACEMENT: the metric the question LITERALLY asks for ("what is the churn rate" → the overall churn rate) must appear as a headline StatCard, bound via its placeholder — not only inside prose.
- The question's phrasing is NOT evidence. If the question presumes a direction ("why is churn rising?") and the results carry a trend key, bind that key — the computed answer may contradict the premise, and the dashboard must side with the computation.`;

/** Static (no-DataController) $chartData rule, single-shot compose rules. */
export const CHART_DATA_PLACEHOLDER_RULE = `Reference chart data using "$chartData:<key>" placeholders in data props. Do NOT inline data arrays. Example: "data": "$chartData:bar_data". For nested fields like heatmap data, use "$chartData:heatmap.z", "$chartData:heatmap.x_labels", "$chartData:heatmap.y_labels".`;

/**
 * Metadata-mode number discipline, single-shot compose rules. Same
 * invariant as noLiteralNumberRule, in the single-shot composer's
 * historical phrasing (byte-pinned by the replay fixtures — see module
 * doc before unifying).
 */
export const METADATA_PLACEHOLDER_RULES: readonly string[] = [
  'Use "$result:<key>" placeholders for ALL scalar values in StatCard value, TrendIndicator value/previous, and any other numeric display props. Never fabricate or guess specific numbers.',
  "TextBlock content must be qualitative and descriptive — do NOT include specific numeric values. Describe trends, patterns, and relationships without citing exact figures.",
  "Never hallucinate specific numeric values. If you need a number displayed, it MUST come from a $result:<key> placeholder.",
];
