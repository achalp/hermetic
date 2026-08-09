/**
 * Deterministic realizer (specs/narrative-compiler-2026-08-09.md §2).
 *
 * One template family per claim dtype, emitting sentences whose every
 * figure is a `$finding:` BINDING — the existing finalizer resolves values
 * and renders declared units, so the whole resolution stack is reused and
 * a realized sentence cannot carry a fabricated number. The honesty
 * clauses live IN the templates: raw-beside-attested, excluded_reason,
 * CI-beside-slope. Hiding them is unrepresentable, not lint-detected.
 *
 * The dtype switch is EXHAUSTIVE over the claim taxonomy with a generic
 * fallback for open-vocabulary dtypes — the exhaustiveness test in
 * __tests__ pins that every taxonomy dtype has a dedicated template.
 */
import type { FindingEntry } from "@/lib/contracts/findings";
import type { PlanNode } from "@/lib/contracts/plan";

const fv = (f: FindingEntry): Record<string, unknown> =>
  f.value !== null && typeof f.value === "object" && !Array.isArray(f.value)
    ? (f.value as Record<string, unknown>)
    : {};

const b = (name: string, field?: string): string =>
  field ? `$finding:${name}.${field}` : `$finding:${name}`;

const humanize = (name: string): string =>
  name
    .replace(/^step_\d+\./, "")
    .split(/[._]/)
    .filter(Boolean)
    .join(" ");

// Zero-policy disclosure (regime-matrix claim-layer totalization): when a
// claim function screened sentinel zeros internally (unit= was passed and
// zero_policy fired), the sentence carries the count — an applied policy
// the reader can't see is the same defect as an unapplied one.
const zeroClause = (n: string, v: Record<string, unknown>): string =>
  typeof v.n_zero_excluded === "number" && v.n_zero_excluded > 0
    ? ` ${b(n, "n_zero_excluded")} zero values were excluded as unrecorded-value sentinels (zero policy).`
    : "";

/** Realize ONE claim into narrative text (bindings, not values).
 *
 * Every dedicated template is SHAPE-GUARDED: the dtype names the template,
 * but the value's fields decide whether it applies — a finding declared
 * dtype "direction" whose value is a per-segment dict must fall back to the
 * generic rendering, not bind fields that don't exist ("Segment
 * heterogeneity: at per period" was two empty interpolations shipped as a
 * sentence). */
export function realizeClaim(f: FindingEntry): string {
  const v = fv(f);
  const n = f.name;
  const label = humanize(n);
  const has = (...fields: string[]) => fields.every((k) => k in v);
  switch (f.dtype) {
    case "direction":
    case "trend": {
      const slopeField = "slope_per_period" in v ? "slope_per_period" : "slope";
      if (!has("direction") || !(slopeField in v)) return generic(f);
      let s = `${cap(label)}: ${b(n, "direction")} at ${b(n, slopeField)} per period${v.weighted === true ? " (count-weighted fit)" : ""}`;
      if ("slope_ci95" in v && v.slope_ci95 !== null) {
        s += ` (95% CI ${b(n, "slope_ci95.0")} to ${b(n, "slope_ci95.1")})`;
      }
      if ("p_value" in v) s += `, p = ${b(n, "p_value")}`;
      return s + "." + zeroClause(n, v);
    }
    case "superlative": {
      if (!has("value")) return generic(f);
      const pf = periodField(v);
      let s = `Among well-covered periods, ${label} is ${b(n, "value")}${pf ? ` in ${b(n, pf)}` : ""} (n = ${b(n, "n")}).`;
      if (v.raw_value !== undefined && v.raw_value !== v.value) {
        s += ` The raw extreme is ${b(n, "raw_value")} in ${b(n, "raw_period")} (n = ${b(n, "raw_n")}), under the ${b(n, "thin_bar")}-observation attestation bar — ${b(n, "thin_periods_skipped")} thin periods were screened from the attested pick.`;
      }
      return s + zeroClause(n, v);
    }
    case "current_state": {
      if (!has("value", "period")) return generic(f);
      let s = `Well-covered data ends at ${b(n, "value")} in ${b(n, "period")}`;
      if (v.pct_from_peak !== null && v.pct_from_peak !== undefined) {
        s += ` (${b(n, "pct_from_peak")} vs the attested peak)`;
      }
      s += ".";
      if (typeof v.excluded_trailing === "number" && v.excluded_trailing > 0) {
        s += ` The final ${b(n, "excluded_trailing")} periods were excluded (${b(n, "excluded_reason")});`;
        s += ` the latest raw observation is ${b(n, "latest_value")} in ${b(n, "latest_period")}${v.latest_n !== null && v.latest_n !== undefined ? ` (n = ${b(n, "latest_n")})` : ""}.`;
      }
      return s + zeroClause(n, v);
    }
    case "comparison": {
      if ("early_median" in v) {
        // The multiplier is None for signed/zero medians — the clause only
        // renders when the ratio is meaningful (the levels carry the story).
        const mult =
          v.multiplier !== null && v.multiplier !== undefined
            ? ` — a ${b(n, "multiplier")}× change`
            : "";
        return `${cap(label)}: median ${b(n, "early_median")} across ${b(n, "early_span")} vs ${b(n, "late_median")} across ${b(n, "late_span")}${mult}.${zeroClause(n, v)}`;
      }
      if ("pct_change" in v) {
        return `${cap(label)}: ${b(n, "pct_change")} from ${b(n, "prior_year")} to ${b(n, "latest_year")} over the ${b(n, "window_months")} overlapping months.${zeroClause(n, v)}`;
      }
      return generic(f);
    }
    case "step_change": {
      if (!has("baseline_spread")) return generic(f);
      if (v.period === null || v.period === undefined) {
        return `No persistent step change was detected in ${label} — level shifts did not survive the persistence and spread gates.${zeroClause(n, v)}`;
      }
      // "steps up by X" stays grammatical for both directions ("a up step"
      // did not).
      return `${cap(label)}: the level steps ${b(n, "direction")} by ${b(n, "delta")} at ${b(n, "period")} (baseline spread ${b(n, "baseline_spread")}).${zeroClause(n, v)}`;
    }
    case "distribution": {
      if (!has("median", "mean")) return generic(f);
      let s = `${cap(label)}: median ${b(n, "median")}, mean ${b(n, "mean")}, skew ${b(n, "skew")}`;
      if ("p25" in v) s += ` (IQR ${b(n, "p25")}–${b(n, "p75")})`;
      return s + "." + zeroClause(n, v);
    }
    case "correlation": {
      if (!has("pearson_r", "spearman_rho")) return generic(f);
      let s = `${cap(label)}: Pearson r = ${b(n, "pearson_r")} (p = ${b(n, "pearson_p")}), Spearman ρ = ${b(n, "spearman_rho")} (p = ${b(n, "spearman_p")}), n = ${b(n, "n")}.`;
      if (typeof v.preferred === "string") {
        s += ` The ${b(n, "preferred")} coefficient is the reliable one under this series' regimes.`;
      }
      return s + zeroClause(n, v);
    }
    case "share": {
      if (!has("shares_pct")) return generic(f);
      return `${cap(label)}: shares ${b(n, "shares_pct")} with residual ${b(n, "residual_pct")}.`;
    }
    case "screen":
    case "check": {
      // A caveat renders ONLY the check's own fields: the declared
      // definition (a literal — the rule as stated) plus up to three
      // scalar evidence figures as bindings. No free-text mechanism exists
      // to fabricate into; booleans are branched on host-side, never bound
      // inline (the resolver refuses inline booleans by design).
      const failed = v.passed === false;
      const ev =
        v.evidence !== null && typeof v.evidence === "object" && !Array.isArray(v.evidence)
          ? (v.evidence as Record<string, unknown>)
          : {};
      const evParts = Object.entries(ev)
        .filter(([, x]) => typeof x === "number")
        .slice(0, 3)
        .map(([k]) => `${humanize(k)}: ${b(n, `evidence.${k}`)}`);
      return `${failed ? "⚠ FAILED — " : ""}${f.definition}${evParts.length > 0 ? ` (${evParts.join(", ")})` : ""}.`;
    }
    default:
      return generic(f);
  }
}

function generic(f: FindingEntry): string {
  // Open-vocabulary dtype: definition + whole-value binding — never a throw
  // at runtime (spec §2); dedicated templates are added by taxonomy.
  return `${cap(humanize(f.name))} — ${f.definition}: ${b(f.name)}.`;
}

function periodField(v: Record<string, unknown>): string | undefined {
  for (const k of ["period", "year", "date", "month"]) if (k in v) return k;
  return undefined;
}

const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Realize a plan node: AUTHORED narrative first (narrated compiled mode —
 *  the planner writes flowing prose whose figures are all bindings, and
 *  the validator has already enforced that), templates as the per-node
 *  fallback. CAVEATs never use authored text (checks render their own
 *  declared fields). */
export function realizeNode(node: PlanNode, byName: Map<string, FindingEntry>): string | null {
  if (node.op === "INSIGHT") return node.text?.trim() || null;
  if (node.op !== "CAVEAT" && node.text?.trim()) return node.text.trim();
  const parts: string[] = [];
  for (const ref of node.refs) {
    const f = byName.get(ref);
    if (f) parts.push(realizeClaim(f));
  }
  if (parts.length === 0) return null;
  if (node.op === "CONTRAST" && parts.length >= 2) {
    return parts.join(" By contrast: ");
  }
  return parts.join(" ");
}
