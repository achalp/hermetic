/**
 * Narrative grounding for Investigate composition.
 *
 * The composer synthesizes a prose narrative (executive summary, per-step
 * insights, conclusion) from the sub-questions' computed results. Semantic
 * result validation (`result-validator.ts`) catches *degenerate* outputs —
 * empty frames, NaN, single-bar charts. It does NOT catch the more dangerous
 * failure mode for a data tool: a *plausible-but-wrong* number stated
 * confidently in the narrative. If the composer writes "revenue grew to
 * $4.7M" but no sub-question ever computed a value near 4.7M, that figure is
 * fabricated and the validator would never know.
 *
 * This module is the guard against that. It does two things:
 *
 *   1. Builds the set of numbers the investigation actually computed
 *      (`collectGroundedValues`) from every sub-question's `results` scalars
 *      and `chart_data` numeric cells.
 *
 *   2. Scans the composed narrative for "data-like" numeric tokens and checks
 *      each against that set (`verifyGrounding`). Anything that can't be
 *      traced is reported so the route can surface an advisory caveat and
 *      record it in the audit trail.
 *
 * Design posture: this is an ADVISORY signal, deliberately tuned for low
 * false positives. We never block or rewrite the dashboard — a flagged number
 * might be a legitimate derived/rounded figure. We only surface "these N
 * figures could not be traced to a computed result; verify before relying on
 * them." Over-flagging would train users to ignore the caveat, so we skip
 * numeric tokens that are unlikely to be data (years, small counts, bare
 * ordinals) and match generously across formatting (currency, thousands
 * separators, %, K/M/B suffixes, rounding).
 */

/** A numeric token lifted from narrative prose, with its display flavor. */
export interface ExtractedNumber {
  /** The raw matched substring, e.g. "$4.7M" or "12.3%". */
  raw: string;
  /** Parsed magnitude after applying currency/suffix/percent scaling. */
  value: number;
  /** Number of fractional digits the author displayed (for rounding match). */
  decimals: number;
  hadPercent: boolean;
  hadCurrency: boolean;
  /** Suffix multiplier: 1, 1e3 (K), 1e6 (M), 1e9 (B). */
  scale: number;
}

// GroundingReport lives in contracts (stream-state carries it across the
// API boundary); re-exported here for existing consumers.
export type { GroundingReport } from "@/lib/contracts/grounding";
import type { GroundingReport } from "@/lib/contracts/grounding";

// ── Collecting the grounded value set ─────────────────────────────────

function pushNumber(into: number[], v: unknown): void {
  if (typeof v === "number" && Number.isFinite(v)) {
    into.push(v);
  } else if (typeof v === "string") {
    // Python sometimes emits numbers as strings ("1234.5"). Accept clean ones.
    const trimmed = v.trim();
    if (trimmed && /^-?\d[\d,]*\.?\d*$/.test(trimmed)) {
      const n = Number(trimmed.replace(/,/g, ""));
      if (Number.isFinite(n)) into.push(n);
    }
  }
}

function walkForNumbers(val: unknown, into: number[], depth = 0): void {
  if (depth > 6) return;
  if (Array.isArray(val)) {
    for (const item of val) walkForNumbers(item, into, depth + 1);
    return;
  }
  if (val && typeof val === "object") {
    for (const v of Object.values(val as Record<string, unknown>)) {
      walkForNumbers(v, into, depth + 1);
    }
    return;
  }
  pushNumber(into, val);
}

/**
 * Collect every finite number the investigation computed, from the merged
 * `results` scalars and `chart_data` arrays. Returns a sorted array (ascending
 * by absolute value is unnecessary; insertion order is fine) used by
 * `verifyGrounding` to test membership.
 */
export function collectGroundedValues(
  results: Record<string, unknown>,
  chartData: Record<string, unknown>
): number[] {
  const nums: number[] = [];
  walkForNumbers(results, nums);
  walkForNumbers(chartData, nums);
  return nums;
}

/**
 * Narrative-bearing prop keys in a JSON-Render node. We collect text from these
 * (not every string) so grounding checks prose and labels but ignores type
 * names, variants, colors, and key paths — which carry digit sequences (hex
 * colors, step_N keys) that would be false positives.
 */
const NARRATIVE_KEYS = new Set([
  "content",
  "label",
  "title",
  "caption",
  "description",
  "summary",
  "text",
]);

/**
 * Recursively pull narrative strings out of a streamed spec patch's `value`.
 * Shared by the Investigate route and the single-shot composer so both ground
 * against the same prose.
 */
export function collectNarrativeStrings(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 8 || value == null) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectNarrativeStrings(item, depth + 1, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string") {
        if (NARRATIVE_KEYS.has(k)) out.push(v);
      } else {
        collectNarrativeStrings(v, depth + 1, out);
      }
    }
  }
  return out;
}

// ── Extracting numbers from narrative prose ───────────────────────────

// Matches optional leading $, then digits with optional thousands separators
// and decimals, then an optional K/M/B/T suffix, then an optional %.
// Examples: 1,234  $4.7M  12.3%  -0.85  $1,234,567.89  3K
//
// The suffix must be ADJACENT to the digits ("4.7M", not "4.7 M") and must not
// be followed by another letter — otherwise the first letter of an ordinary
// following word is consumed as a multiplier ("12 months" → 12M, "5 buyers" →
// 5B), inflating the value and producing false ungrounded flags. `bn` is
// listed before `b` so it wins the alternation.
const NUMBER_RE =
  /(\$|€|£)?\s?(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)(?:(bn|k|m|b|t)(?![a-z]))?\s?(%)?/gi;

function suffixScale(suffix: string | undefined): number {
  switch ((suffix ?? "").toLowerCase()) {
    case "k":
      return 1e3;
    case "m":
      return 1e6;
    case "b":
    case "bn":
      return 1e9;
    case "t":
      return 1e12;
    default:
      return 1;
  }
}

/** Pull every numeric token out of a prose string. */
export function extractNumbers(text: string): ExtractedNumber[] {
  const out: ExtractedNumber[] = [];
  for (const m of text.matchAll(NUMBER_RE)) {
    const [raw, currency, digits, suffix, percent] = m;
    const cleaned = digits.replace(/,/g, "");
    const base = Number(cleaned);
    if (!Number.isFinite(base)) continue;
    const scale = suffixScale(suffix);
    const dot = cleaned.indexOf(".");
    const decimals = dot === -1 ? 0 : cleaned.length - dot - 1;
    out.push({
      raw: raw.trim(),
      value: base * scale,
      decimals,
      hadPercent: !!percent,
      hadCurrency: !!currency,
      scale,
    });
  }
  return out;
}

/**
 * Should this token be checked for grounding at all? We skip tokens that are
 * very unlikely to be data the composer pulled from a result, to keep false
 * positives low:
 *
 * - Years (1900–2100) with no currency/percent/suffix and no decimals.
 * - Small bare integers (|v| < 1000) with no currency/percent/suffix/decimals —
 *   these are usually counts, ordinals, "top 5", "3 segments", step numbers.
 *
 * A number wearing any data costume ($, %, K/M/B, or a decimal point) is always
 * checked, even if small — "$4.50" and "2.3%" are exactly the figures worth
 * verifying.
 */
function isDataLike(n: ExtractedNumber): boolean {
  const dressed = n.hadCurrency || n.hadPercent || n.scale > 1 || n.decimals > 0;
  if (dressed) return true;
  const abs = Math.abs(n.value);
  // Bare integer that looks like a calendar year — skip (almost never a figure
  // the composer would need to ground, and "in 2024" is a common false flag).
  if (Number.isInteger(n.value) && abs >= 1900 && abs <= 2100) return false;
  if (abs >= 1000) return true; // large bare integer — likely a computed total
  return false; // small bare integer — skip
}

// ── Matching a narrative number against the grounded set ──────────────

/**
 * Does `target` match any grounded value, allowing for rounding and the
 * percent/ratio ambiguity (a result stored as 0.123 may be shown as "12.3%")?
 */
function matchesAny(n: ExtractedNumber, grounded: number[]): boolean {
  // Candidate magnitudes the displayed token could correspond to.
  const candidates = [n.value];
  if (n.hadPercent) {
    // "12.3%" might be stored as 0.123 (ratio) or 12.3 (already a percent).
    candidates.push(n.value / 100);
  }

  for (const cand of candidates) {
    for (const g of grounded) {
      if (numbersClose(cand, g, n.decimals, n.scale)) return true;
      // Reverse percent: result stored as ratio, narrative shows percent.
      if (n.hadPercent && numbersClose(n.value, g * 100, n.decimals, n.scale)) return true;
    }
  }
  return false;
}

/**
 * Close enough to count as the same number, given the author rounded the
 * MANTISSA to `decimals` places at display scale `suffixScale` ("1.2K" means
 * the author rounded 1234 to 1.2 at scale 1e3, not to 1200.0). We accept a
 * match if either:
 *   - rounding both mantissas to the displayed precision makes them equal, OR
 *   - they agree within a relative tolerance (handles "$4.7M" ≈ 4_683_120).
 */
function numbersClose(a: number, b: number, decimals: number, suffixScale = 1): boolean {
  if (a === b) return true;
  // Compare at the precision the author actually displayed: one fractional
  // digit on a K-suffixed figure is a precision of 100, not 0.1.
  const factor = Math.pow(10, decimals) / suffixScale;
  if (Math.round(a * factor) === Math.round(b * factor)) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return true;
  // 1.5% relative tolerance covers M/K/B rounding ("4.7M" for 4_683_120 → 0.4%).
  const rel = Math.abs(a - b) / scale;
  return rel <= 0.015;
}

// ── Step citations ────────────────────────────────────────────────────

/**
 * Extract the 1-based step numbers a narrative chunk cites in PROSE:
 * "Step 2", "step_3", "(Steps 1, 4)", "steps 1 and 4". Only call this on
 * narrative text (collected from prose-bearing props) — running it on a raw
 * spec line would count element IDs / key paths like "step_3_chart" as
 * citations and suppress the uncited-steps advisory.
 */
export function extractCitedSteps(text: string): number[] {
  const steps = new Set<number>();
  // Singular or plural, with comma/and/& lists: "Step 2", "Steps 1, 4 and 7".
  for (const m of text.matchAll(/\bsteps?[\s_]?(\d+(?:\s*(?:,|and|&)\s*\d+)*)/gi)) {
    for (const d of m[1].match(/\d+/g) ?? []) {
      const n = Number(d);
      if (Number.isInteger(n) && n > 0) steps.add(n);
    }
  }
  for (const n of extractPlaceholderCitedSteps(text)) steps.add(n);
  return [...steps].sort((a, b) => a - b);
}

/**
 * Extract step numbers from placeholder references the composer emitted:
 * "$result:step_2_total" / "$chartData:step_3_bars". Safe to run on a raw
 * PRE-resolution spec line — placeholders are unambiguous, unlike prose
 * "step N" mentions.
 */
export function extractPlaceholderCitedSteps(text: string): number[] {
  const steps = new Set<number>();
  for (const m of text.matchAll(/\$(?:result|chartData):step_(\d+)_/g)) {
    const n = Number(m[1]);
    if (Number.isInteger(n) && n > 0) steps.add(n);
  }
  return [...steps].sort((a, b) => a - b);
}

// ── Top-level verification ────────────────────────────────────────────

export interface VerifyArgs {
  /** Resolved narrative strings (placeholders already substituted to values). */
  narrativeTexts: string[];
  /** 1-based step numbers the narrative cited (from prose + placeholders). */
  citedSteps: number[];
  /** Numbers the investigation actually computed. */
  grounded: number[];
  /** 1-based step numbers that produced a usable (success/degraded) result. */
  successfulStepNos: number[];
  /**
   * Result scalars, for the DIRECTIONAL check: when the analysis computed an
   * explicit trend verdict (a key named like trend, direction, or rising)
   * and the narrative asserts the OPPOSITE direction, that is a
   * contradiction — the plausible-but-wrong failure in its most damaging
   * form, since the story denies the engine's own finding. Optional:
   * callers without result scalars skip the check.
   */
  results?: Record<string, unknown>;
}

// ── Directional claims ───────────────────────────────────────────────
// Deliberately conservative, mirroring the numeric posture: we only flag a
// contradiction when the computed trend keys are UNANIMOUS about a direction
// and the narrative asserts the opposite. Mixed metrics (churn dollars rising
// while churn rate falls) produce non-unanimous keys → silence.

const UP_WORDS =
  /\b(?:rising|rise[sn]?|rose|climb(?:ed|ing|s)?|gr[eo]w(?:ing|s|n|th)?|increas(?:e[sd]?|ing)|accelerat(?:e[sd]?|ing)|upward|trending up)\b/i;
const DOWN_WORDS =
  /\b(?:falling|f[ae]ll(?:en|s)?|declin(?:e[sd]?|ing)|decreas(?:e[sd]?|ing)|dropp(?:ed|ing)|drops?\b|shrink(?:ing|s)?|shrank|downward|trending down)\b/i;
/** A negation shortly before a direction word flips/voids the assertion. */
const NEGATION =
  /\b(?:not|no longer|isn't|wasn't|stopped|without|rather than|instead of)\s+(?:\w+\s+){0,2}$/i;

function assertedDirection(text: string): "up" | "down" | null {
  const up = UP_WORDS.exec(text);
  const down = DOWN_WORDS.exec(text);
  const clean = (m: RegExpExecArray | null) =>
    m !== null && !NEGATION.test(text.slice(Math.max(0, m.index - 40), m.index));
  const hasUp = clean(up);
  const hasDown = clean(down);
  // Both directions in one narrative (e.g. "dollars rose while the rate fell")
  // is nuance, not a claim to police.
  if (hasUp && hasDown) return null;
  return hasUp ? "up" : hasDown ? "down" : null;
}

/**
 * The direction the RESULTS assert, when they are unanimous. Reads boolean
 * keys whose names contain rising, increasing, or growing (true → up) or
 * falling, declining (true → down), and string keys whose names contain
 * trend or direction with values like "rising" or "falling". Returns null
 * when no key speaks or keys disagree.
 */
function computedDirection(results: Record<string, unknown>): "up" | "down" | null {
  const votes = new Set<"up" | "down">();
  const visit = (obj: Record<string, unknown>) => {
    for (const [key, val] of Object.entries(obj)) {
      const k = key.toLowerCase();
      if (val !== null && typeof val === "object" && !Array.isArray(val)) {
        visit(val as Record<string, unknown>);
        continue;
      }
      if (typeof val === "boolean") {
        if (/(rising|increasing|growing|upward|uptrend)/.test(k)) votes.add(val ? "up" : "down");
        else if (/(falling|declining|decreasing|downward|downtrend)/.test(k))
          votes.add(val ? "down" : "up");
      } else if (typeof val === "string" && /(trend|direction)/.test(k)) {
        const v = val.toLowerCase();
        if (/(rising|increasing|growing|up)/.test(v)) votes.add("up");
        else if (/(falling|declining|decreasing|down)/.test(v)) votes.add("down");
        // "flat"/"stable" casts no vote — a flat verdict contradicts neither
        // phrasing strongly enough for a low-false-positive advisory.
      }
    }
  };
  visit(results);
  if (votes.size !== 1) return null;
  return [...votes][0];
}

/**
 * Verify the composed narrative against what was actually computed. Returns a
 * report the route surfaces as an advisory caveat and stores in the trace.
 */
export function verifyGrounding(args: VerifyArgs): GroundingReport {
  const ungrounded: string[] = [];
  let checkedCount = 0;
  const seen = new Set<string>();

  for (const text of args.narrativeTexts) {
    for (const n of extractNumbers(text)) {
      if (!isDataLike(n)) continue;
      checkedCount++;
      if (matchesAny(n, args.grounded)) continue;
      // De-dupe identical raw tokens so one fabricated figure repeated across
      // sections is reported once.
      if (seen.has(n.raw)) continue;
      seen.add(n.raw);
      ungrounded.push(n.raw);
    }
  }

  const citedSet = new Set(args.citedSteps);
  const uncitedSuccessfulSteps = args.successfulStepNos.filter((s) => !citedSet.has(s));

  // Directional contradiction: the narrative asserts one direction while the
  // computed trend keys unanimously say the other. (The c411967f class of
  // failure: "churn rate rising every month" beside churn_rate_trend_rising:
  // false — numbers all traced, story still wrong.)
  const contradictions: string[] = [];
  if (args.results) {
    const computed = computedDirection(args.results);
    if (computed) {
      for (const text of args.narrativeTexts) {
        const asserted = assertedDirection(text);
        if (asserted && asserted !== computed) {
          contradictions.push(
            `narrative asserts a ${asserted === "up" ? "rising" : "falling"} trend but the ` +
              `computed trend result says ${computed === "up" ? "rising" : "falling"}`
          );
          break; // one report per run — advisory, not a lint pass
        }
      }
    }
  }

  return {
    ok: ungrounded.length === 0 && contradictions.length === 0,
    checkedCount,
    ungrounded,
    ...(contradictions.length > 0 ? { contradictions } : {}),
    citedSteps: [...citedSet].sort((a, b) => a - b),
    uncitedSuccessfulSteps,
  };
}

// Test seam
export const __testing = {
  extractNumbers,
  isDataLike,
  matchesAny,
  numbersClose,
  assertedDirection,
  computedDirection,
};
