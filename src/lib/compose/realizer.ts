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
import { TEXT_REQUIRED_OPS } from "./plan";

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

/** Smallest group size below which a heterogeneity verdict carries a
 *  pooling disclosure (spec §2.M4). Not a statistical gate — a trigger for
 *  saying out loud what the test rests on. Audited (run f47eb42d):
 *  kruskal-wallis "differ meaningfully, p=0.0011" shipped over group sizes
 *  of 2, 3 and 5 among eleven, unqualified. */
const THIN_GROUP_DISCLOSURE_N = 6;

/**
 * The RIDER clauses for one claim: deterministic, findings-bound honesty
 * disclosures that must reach the reader whether the narrative was authored
 * by the planner or realized from templates (spec
 * finding-field-roles-2026-08-13 §2.M4 — cause D). Before this split,
 * realizeNode returned authored text INSTEAD of the template, so every one
 * of these clauses was inert in narrated compiled mode: run f47eb42d
 * headlined the catch-all "Other" with `label_is_catchall: true` sitting
 * unread on the claim.
 *
 * Riders are appended to authored text and included in template rendering,
 * so suppressing one is unrepresentable in either mode.
 */
export function riderClauses(f: FindingEntry): string[] {
  const v = fv(f);
  const n = f.name;
  const riders: string[] = [];
  switch (f.dtype) {
    case "superlative": {
      if (!("value" in v)) break;
      if (v.raw_value !== undefined && v.raw_value !== null && v.raw_value !== v.value) {
        riders.push(
          `The raw extreme is ${b(n, "raw_value")} in ${b(n, "raw_period")} (n = ${b(n, "raw_n")}), under the ${b(n, "thin_bar")}-observation attestation bar — ${b(n, "thin_periods_skipped")} thin periods were screened from the attested pick.`
        );
      } else if (
        typeof v.thin_periods_skipped === "number" &&
        v.thin_periods_skipped > 0 &&
        v.thin_bar !== null &&
        v.thin_bar !== undefined
      ) {
        // Silent-disqualification disclosure (run 5872407b): when the raw and
        // attested winners COINCIDE, the raw-beside-attested rider above never
        // fires — yet candidates were still screened out. The audited case:
        // the second-largest dollar category (n = 3) was disqualified under
        // the bar of 5 and nothing said so, which materially framed "top
        // category". Colon-form for number-noun agreement.
        riders.push(
          `Candidates screened out as thin under the ${b(n, "thin_bar")}-observation attestation bar: ${b(n, "thin_periods_skipped")}.`
        );
      }
      // A catch-all winner is a statement about unclassified residue, not
      // about a real group. Audited (run 77051c9d): "Other" (n = 45, 35% of
      // transactions) headlined a spend analysis as the dominant category
      // with nothing saying it was the leftovers. Static phrasing — the
      // earlier label interpolation produced "names unclassified top spend
      // category", a finding NAME wearing a noun's clothes (run 5872407b).
      if (v.label_is_catchall === true) {
        riders.push(
          `That leader is a catch-all bucket — it aggregates records the analysis could not classify, rather than naming a real group.`
        );
      }
      // The bar is series-relative, so two superlatives in one run can carry
      // different thin_bars. Say so when this one's floor was relaxed —
      // otherwise an n = 3 winner here looks equivalent to an n = 3 loser
      // that a stricter sibling bar screened out.
      if (v.bar_relaxed === true) {
        // Phrased to dodge number-noun agreement: thin_bar is a binding, so
        // "of 1 observations" was ungrammatical at n = 1 (run 093c9785).
        riders.push(
          `Attestation here rests on a bar relaxed to ${b(n, "thin_bar")}, because the series is uniformly thin.`
        );
      }
      break;
    }
    case "current_state": {
      if (typeof v.excluded_trailing === "number" && v.excluded_trailing > 0) {
        // Colon-form to dodge number-noun agreement on a binding: "The
        // final 1 periods were excluded" shipped in run dfe3ea32.
        riders.push(
          `Trailing periods excluded from the series' end: ${b(n, "excluded_trailing")} (${b(n, "excluded_reason")}); the latest raw observation is ${b(n, "latest_value")} in ${b(n, "latest_period")}${v.latest_n !== null && v.latest_n !== undefined ? ` (n = ${b(n, "latest_n")})` : ""}.`
        );
      }
      break;
    }
    case "heterogeneity": {
      const groups =
        v.group_ns !== null && typeof v.group_ns === "object" && !Array.isArray(v.group_ns)
          ? Object.values(v.group_ns as Record<string, unknown>).filter(
              (x): x is number => typeof x === "number"
            )
          : [];
      if (groups.length > 0 && Math.min(...groups) < THIN_GROUP_DISCLOSURE_N) {
        riders.push(
          `The test pools groups of very different sizes (group sizes: ${b(n, "group_ns")}) — the smallest contribute only a handful of observations, so treat the verdict as directional for them.`
        );
      }
      break;
    }
  }
  const zc = zeroClause(n, v).trim();
  if (zc) riders.push(zc);
  return riders;
}

/** Realize ONE claim into narrative text (bindings, not values).
 *
 * Every dedicated template is SHAPE-GUARDED: the dtype names the template,
 * but the value's fields decide whether it applies — a finding declared
 * dtype "direction" whose value is a per-segment dict must fall back to the
 * generic rendering, not bind fields that don't exist ("Segment
 * heterogeneity: at per period" was two empty interpolations shipped as a
 * sentence). */
export function realizeClaim(f: FindingEntry): string {
  const head = headlineClause(f);
  return [head, ...riderClauses(f)].join(" ");
}

/** The HEADLINE sentence for one claim — the part authored text replaces.
 *  Riders (riderClauses) are composed around it by realizeClaim /
 *  realizeNode and are never part of the headline. */
function headlineClause(f: FindingEntry): string {
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
      return s + ".";
    }
    case "superlative": {
      if (!has("value")) return generic(f);
      const pf = periodField(v);
      return `Among well-covered periods, ${label} is ${b(n, "value")}${pf ? ` in ${b(n, pf)}` : ""} (n = ${b(n, "n")}).`;
    }
    case "current_state": {
      if (!has("value", "period")) return generic(f);
      let s = `Well-covered data ends at ${b(n, "value")} in ${b(n, "period")}`;
      // pct_from_peak of 0 means the current period IS the peak — "sits 0%
      // off the peak" narrates a tautology as a finding (run dfe3ea32).
      // Say what it means instead.
      if (v.pct_from_peak === 0) {
        s += ` — the attested peak itself`;
      } else if (v.pct_from_peak !== null && v.pct_from_peak !== undefined) {
        s += ` (${b(n, "pct_from_peak")} vs the attested peak)`;
      }
      return s + ".";
    }
    case "comparison": {
      if ("early_median" in v) {
        // The multiplier is None for signed/zero medians — the clause only
        // renders when the ratio is meaningful (the levels carry the story).
        const mult =
          v.multiplier !== null && v.multiplier !== undefined
            ? ` — a ${b(n, "multiplier")}× change`
            : "";
        return `${cap(label)}: median ${b(n, "early_median")} across ${b(n, "early_span")} vs ${b(n, "late_median")} across ${b(n, "late_span")}${mult}.`;
      }
      if ("pct_change" in v) {
        return `${cap(label)}: ${b(n, "pct_change")} from ${b(n, "prior_year")} to ${b(n, "latest_year")} over the ${b(n, "window_months")} overlapping months.`;
      }
      return generic(f);
    }
    case "step_change": {
      if (!has("baseline_spread")) return generic(f);
      if (v.period === null || v.period === undefined) {
        return `No persistent step change was detected in ${label} — level shifts did not survive the persistence and spread gates.`;
      }
      // "steps up by X" stays grammatical for both directions ("a up step"
      // did not).
      return `${cap(label)}: the level steps ${b(n, "direction")} by ${b(n, "delta")} at ${b(n, "period")} (baseline spread ${b(n, "baseline_spread")}).`;
    }
    case "distribution": {
      if (!has("median", "mean")) return generic(f);
      let s = `${cap(label)}: median ${b(n, "median")}, mean ${b(n, "mean")}, skew ${b(n, "skew")}`;
      if ("p25" in v) s += ` (IQR ${b(n, "p25")}–${b(n, "p75")})`;
      return s + ".";
    }
    case "correlation": {
      if (!has("pearson_r", "spearman_rho")) return generic(f);
      let s = `${cap(label)}: Pearson r = ${b(n, "pearson_r")} (p = ${b(n, "pearson_p")}), Spearman ρ = ${b(n, "spearman_rho")} (p = ${b(n, "spearman_p")}), n = ${b(n, "n")}.`;
      if (typeof v.preferred === "string") {
        s += ` The ${b(n, "preferred")} coefficient is the reliable one under this series' regimes.`;
      }
      return s;
    }
    case "heterogeneity": {
      // Dedicated template (was generic): the verdict names its test and
      // p-value; the thin-groups disclosure is a rider (spec §2.M4).
      if (!has("p_value", "test")) return generic(f);
      return `${cap(label)}: ${b(n, "test")}, p = ${b(n, "p_value")}.`;
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
 *  declared fields).
 *
 *  Authored text does NOT suppress rider clauses (spec
 *  finding-field-roles-2026-08-13 §2.M4): the deterministic honesty
 *  disclosures of each referenced claim are APPENDED after the authored
 *  prose. `rideredClaims`, when supplied by the caller iterating a whole
 *  document, ensures each claim's riders attach at the FIRST node that
 *  references it rather than repeating under every mention. */
export function realizeNode(
  node: PlanNode,
  byName: Map<string, FindingEntry>,
  rideredClaims?: Set<string>
): string | null {
  const authored = node.op !== "CAVEAT" ? node.text?.trim() : undefined;
  const ridersFor = (refs: string[]): string[] => {
    const out: string[] = [];
    for (const ref of refs) {
      if (rideredClaims?.has(ref)) continue;
      const f = byName.get(ref);
      if (!f) continue;
      for (const rider of riderClauses(f)) {
        // Within-node dedup (run 093c9785): the planner may have ALREADY
        // said what the rider says — its heterogeneity sentence bound
        // group_ns, and the thin-groups rider then repeated the identical
        // mapping one sentence later. A rider whose every binding already
        // appears in the authored text adds emphasis, not information —
        // skip it. Riders with no bindings (pure-prose disclosures like
        // the catch-all clause) always attach; prose can't be
        // fingerprinted reliably and the disclosure is the point.
        const bindings = rider.match(/\$finding:[a-zA-Z0-9_.]+/g) ?? [];
        const saidAlready =
          authored !== undefined &&
          bindings.length > 0 &&
          bindings.every((t) => authored.includes(t));
        if (!saidAlready) out.push(rider);
      }
      rideredClaims?.add(ref);
    }
    return out;
  };
  if (node.op === "INSIGHT") {
    if (!authored) return null;
    return [authored, ...ridersFor(node.refs)].join(" ");
  }
  if (authored) return [authored, ...ridersFor(node.refs)].join(" ");
  // Document ops ARE their authored text — with none, they render nothing
  // (never a claim-template dump under a heading/method/conclusion label).
  if (TEXT_REQUIRED_OPS.has(node.op)) return null;
  return realizeNodeTemplate(node, byName, rideredClaims);
}

/** The TEMPLATE rendering of a node, authored text ignored — the
 *  deterministic floor. Used as realizeNode's no-text path, and by the
 *  post-render invariant (spec §2.M5) to replace a node whose authored
 *  text resolved to nothing: a template realization is findings-bound and
 *  cannot be empty for a node with resolvable refs. */
export function realizeNodeTemplate(
  node: PlanNode,
  byName: Map<string, FindingEntry>,
  rideredClaims?: Set<string>
): string | null {
  const parts: string[] = [];
  for (const ref of node.refs) {
    const f = byName.get(ref);
    if (!f) continue;
    if (rideredClaims?.has(ref)) {
      // Riders for this claim already rendered earlier in the document —
      // repeat only the headline.
      parts.push(headlineClause(f));
    } else {
      parts.push(realizeClaim(f));
      rideredClaims?.add(ref);
    }
  }
  if (parts.length === 0) return null;
  if (node.op === "CONTRAST" && parts.length >= 2) {
    return parts.join(" By contrast: ");
  }
  return parts.join(" ");
}
