/**
 * Findings coherence lints (spec §3.3, §7.2, §7.3) — pure, advisory.
 * Split from the former lints.ts god module (L7); see ./index.ts.
 */
import type { FindingEntry, FindingIssue } from "@/lib/contracts/findings";
import type { ProductRolesIndex } from "@/lib/product";
import { SCREEN_LIKE_DTYPES } from "./screen-dtypes";

/** A finding whose claimed period sits on a count under 20% of the series
 *  median rests on the thinnest data in the corpus — the effect-side
 *  detector for any calibration that lets a thin edge through. Two shapes:
 *  superlatives (peak/max/min names, run-39's 52-item crowned year) and
 *  current-state findings (pct_from_peak whose endpoint is a thin tail —
 *  the 484-item final decade narrated as "prices fell 50% from peak"). */
export function lintThinSuperlative(
  chartData: Record<string, unknown>,
  findings: FindingEntry[],
  rolesIdx?: ProductRolesIndex
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  const X_KEYS = ["year", "month", "date", "period", "x", "label", "decade"];
  /** n at `period` vs the series-median count, from the first chart series
   *  that carries both a count column and the period's row. */
  const attestationAt = (
    period: unknown
  ): { n: number; medN: number; countCol: string } | undefined => {
    for (const [key, v] of Object.entries(chartData)) {
      const rows = Array.isArray(v) ? v : (v as { rows?: unknown[] } | null)?.rows;
      if (!Array.isArray(rows) || rows.length < 5 || typeof rows[0] !== "object") continue;
      const cols = Object.keys(rows[0] as Record<string, unknown>);
      const info = rolesIdx?.get(key);
      const countCol =
        info?.countCol ??
        cols.find((c) =>
          /(^|_)(item_count|n_items|count|listings|n_obs|observations)($|_)/.test(c)
        );
      const xCol = info?.xCol ?? cols.find((c) => X_KEYS.includes(c.toLowerCase()));
      if (!countCol || !xCol) continue;
      const counts = (rows as Record<string, unknown>[])
        .map((r) => r[countCol])
        .filter((x): x is number => typeof x === "number")
        .sort((a, b) => a - b);
      if (counts.length < 5) return undefined;
      // COUNT-WEIGHTED median (same bar the runtime's _attestation_bar
      // applies): the reference is where the observations live — a sparse
      // tail of small periods must not drag the bar down (a 178.8 bar let a
      // 382-item year headline a corpus with a 124k-item year in it).
      const total = counts.reduce((a, b) => a + b, 0);
      let acc = 0;
      let medN = counts[counts.length - 1];
      for (const c of counts) {
        acc += c;
        if (acc >= total / 2) {
          medN = c;
          break;
        }
      }
      const row = (rows as Record<string, unknown>[]).find(
        (r) => String(r[xCol]) === String(period)
      );
      const n = row?.[countCol];
      return typeof n === "number" ? { n, medN, countCol } : undefined;
    }
    return undefined;
  };
  for (const f of findings) {
    if (f.value === null || typeof f.value !== "object") continue;
    const fv = f.value as Record<string, unknown>;
    const period = fv.period ?? fv.year ?? fv.date ?? fv.month;
    if (period === undefined || issues.length >= 3) continue;
    const isSuperlative =
      /peak|max|min|trough|largest|smallest/.test(f.name) && fv.value !== undefined;
    const isCurrentState = "pct_from_peak" in fv && fv.pct_from_peak !== null;
    if (!isSuperlative && !isCurrentState) continue;
    const att = attestationAt(period);
    // Same bar family as the runtime's _attestation_bar: the absolute floor
    // is capped at the median — a period matching the corpus-typical count
    // is never thin (uniformly small counts must not flag everything).
    if (!att || att.n >= Math.max(Math.min(5, att.medN), 0.2 * att.medN)) continue;
    if (isSuperlative) {
      issues.push({
        kind: "thin_superlative",
        name: f.name,
        detail: `${f.name} crowns ${String(period)} on ${att.n} ${att.countCol} (series median ${att.medN}) — the headline superlative rests on the thinnest data in the corpus; use finding_superlative (attestation-weighted) and report the raw extreme beside it`,
      });
    } else {
      issues.push({
        kind: "thin_current_state",
        name: f.name,
        detail: `${f.name} ends the series at ${String(period)} on ${att.n} ${att.countCol} (series median ${att.medN}) — pct_from_peak measured against a thin tail narrates a collection gap as a decline; pass counts= to finding_current_state so the unattested edge is excluded`,
      });
    }
  }
  return issues;
}

// ── Referent-integrity lints (MCP deep-dive review 2026-08-09): prose,
// results, and executed transformations must all point at declarations
// that EXIST. Three faces of one defect: a citation naming a finding the
// manifest doesn't carry, a dispatcher decision shipped as bare results
// keys, and a screen that executed with no finding declaring it. ──────────

/** Narrative citing a finding id that does not exist ("the trend
 *  (median_price_trend finding) reflects...") — worse than saying no
 *  finding is available, because it asserts provenance that is missing.
 *  SEVERE: the recompose pass must rewrite or drop the citation. */
export function lintDanglingFindingReference(
  narrativeTexts: string[],
  findings: FindingEntry[]
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  if (narrativeTexts.length === 0) return issues;
  const names = new Set(findings.map((f) => f.name));
  const text = narrativeTexts.join("\n");
  // A snake_case identifier explicitly cited AS a finding/check/screen.
  const CITE_RE = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\s+(?:finding|check|screen)\b/g;
  const seen = new Set<string>();
  for (const m of text.matchAll(CITE_RE)) {
    const name = m[1];
    if (seen.has(name) || names.has(name) || names.has(name.replace(/^step_\d+\./, ""))) continue;
    seen.add(name);
    issues.push({
      kind: "dangling_finding_reference",
      name,
      detail: `narrative cites "${name}" as a finding, but the manifest declares no such finding — the citation asserts provenance that does not exist; name only findings that are actually declared (or state plainly that none is available)`,
    });
  }
  return issues;
}

/** Dispatcher decisions shipped as bare results keys with no declaration
 *  behind them (preferred_price_metric / split_at_year / *_policy): the
 *  decision ran, the reason is unrecorded, and nothing in the manifest can
 *  be audited for it. Decisions are declared as checks. */
export function lintOrphanDecisionResult(
  results: Record<string, unknown>,
  findings: FindingEntry[]
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  const findingTokens = findings.map(
    (f) => new Set((f.name + "_" + f.definition.toLowerCase()).split(/[^a-z0-9]+/))
  );
  for (const key of Object.keys(results)) {
    if (issues.length >= 4) break;
    if (!/^(preferred_|split_at)|(_policy|_convention|_method_choice)$/.test(key)) continue;
    if (/_reason$/.test(key)) continue; // flagged via its base key
    const toks = key.split(/[._]/).filter((t) => t.length > 2);
    const backed = findingTokens.some((ft) => toks.filter((t) => ft.has(t)).length >= 2);
    if (!backed) {
      issues.push({
        kind: "orphan_decision_result",
        name: key,
        detail: `results.${key} records a methodological decision with no finding behind it — declare the decision as a check (evidence = the dispatcher's dict, reason included) so the choice is auditable; a bare results key outlives its own rationale`,
      });
    }
  }
  return issues;
}

/** A trend fit UNWEIGHTED over a series that declares a count role: the
 *  estimator choice is then whatever the model remembered this run — an
 *  observed -350.4/yr (weighted, p=1e-12) flipped to -20.2 "flat"
 *  (unweighted, p=0.09) on identical data. counts= is required when the
 *  declaration itself says observations-per-period exist. */
export function lintUnweightedCountedTrend(
  findings: FindingEntry[],
  rolesIdx?: ProductRolesIndex
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  const counted = [...(rolesIdx ?? [])].filter(([, info]) => info.countCol);
  if (counted.length === 0) return issues;
  for (const f of findings) {
    if (issues.length >= 3) break;
    if (f.dtype !== "trend" && f.dtype !== "direction") continue;
    const v = f.value;
    if (v === null || typeof v !== "object" || Array.isArray(v)) continue;
    if ((v as Record<string, unknown>).weighted !== false) continue;
    // Prefer an exact column linkage; fall back to "some counted series
    // exists" — the advisory names what to pass either way.
    const cols = new Set(f.derived_from_columns ?? []);
    const match =
      counted.find(([, info]) => info.measures.some((m) => cols.has(m.column))) ??
      (cols.size === 0 ? counted[0] : undefined);
    if (!match) continue;
    issues.push({
      kind: "unweighted_counted_trend",
      name: f.name,
      detail: `finding ${f.name} fit an UNWEIGHTED trend while declared series ${match[0]} carries a count role (${match[1].countCol}) — pass counts= so the fit is count-weighted; the estimator must not depend on what this run happened to remember (an identical corpus flipped falling→flat when the weighting toggled)`,
    });
  }
  return issues;
}

/** A monetary measure grouped by a currency/unit-like column: plotting the
 *  groups on ONE value axis (Francs at 450 beside Dollars at 0.60) or
 *  differencing across them is invalid arithmetic — the heterogeneity test
 *  that fires on such data is the evidence AGAINST pooling, not beside it. */
export function lintMixedUnitGroupSeries(rolesIdx?: ProductRolesIndex): FindingIssue[] {
  const issues: FindingIssue[] = [];
  const UNIT_GROUP_RE = /currenc|denomination|unit/i;
  for (const [id, info] of rolesIdx ?? []) {
    if (issues.length >= 2) break;
    if (!info.groupCol || !UNIT_GROUP_RE.test(info.groupCol)) continue;
    const monetary = info.measures.some(
      (m) => m.unit && /usd|eur|gbp|\$|dollar|price|amount/i.test(m.unit)
    );
    if (!monetary && !info.measures.some((m) => /price|amount|cost|revenue/i.test(m.column)))
      continue;
    issues.push({
      kind: "mixed_unit_group_series",
      name: id,
      detail: `series ${id} groups a monetary measure by ${info.groupCol} — different currencies cannot share one value axis or be differenced (a 499.75 "range across currencies" subtracts Lire from Dollars); restrict to the dominant currency (declared) or present per-group panels/shares`,
    });
  }
  return issues;
}

/**
 * Auto-surface undeclared failed checks (run 093c9785, third recurrence of
 * the class): generated code keeps writing check VERDICTS into bare results
 * keys — `outlier_transaction_detail_passed: false` beside
 * `outlier_transaction_detail_n_flagged: 21` — without a declare_check
 * behind them. A failed check that lives only in results is invisible to
 * everything that exists to surface it: the caveat machinery, the failed-
 * check banner, the CAVEAT plan nodes, the Verify panel, the blocking gate.
 * Two consecutive audits flagged the same silence.
 *
 * The fix follows the auto-surfacing precedent (headline-tile injection):
 * detection alone would be one more advisory nobody reads. A results key
 * `<name>_passed === false` with no declared finding owning `<name>` is
 * APPENDED to the manifest as a real check entry — passed: false, evidence
 * gathered from its sibling `<name>_*` scalars — so every downstream
 * surface treats it exactly like a declared failure. The definition states
 * only facts: that the analysis computed the verdict and did not declare
 * it. Nothing is invented; the mechanism is the absence of a mechanism.
 *
 * Passed=true undeclared verdicts are NOT surfaced (a passing check missing
 * from the manifest costs nothing); they still trip lintResultsProvenance.
 * Returns the appended entries and one issue per surfaced check — the
 * issue is the code-quality signal (the model should have declared it),
 * the entry is the reader's protection.
 */
export function surfaceUndeclaredFailedChecks(
  results: Record<string, unknown>,
  findings: FindingEntry[]
): { added: FindingEntry[]; issues: FindingIssue[] } {
  const added: FindingEntry[] = [];
  const issues: FindingIssue[] = [];
  const declared = findings.map((f) => f.name);
  for (const [key, value] of Object.entries(results ?? {})) {
    if (!key.endsWith("_passed") || value !== false) continue;
    const base = key.slice(0, -"_passed".length);
    if (!base || !/^[a-z][a-z0-9_]*$/.test(base)) continue;
    // Owned when a declared finding's name prefixes the key — the same rule
    // the results-mirror synthesis uses to name mirrored fields.
    if (declared.some((d) => key === `${d}_passed` || key.startsWith(`${d}_`))) continue;
    if (findings.some((f) => f.name === base)) continue;
    // Evidence NESTED under `evidence` — the realizer's check template
    // renders up to three numeric evidence figures onto the caveat's face
    // ("n flagged: 89"), and it reads them from v.evidence. Run dfe3ea32's
    // surfaced caveats shipped without their numbers because the sibling
    // scalars sat flat on the value.
    const evidence: Record<string, unknown> = {};
    for (const [k2, v2] of Object.entries(results)) {
      if (k2 === key || !k2.startsWith(`${base}_`)) continue;
      const field = k2.slice(base.length + 1);
      if (v2 === null || typeof v2 !== "object") evidence[field] = v2;
    }
    added.push({
      name: base,
      dtype: "check",
      definition: "An automatic data-quality check on this result did not pass",
      value: { passed: false, ...(Object.keys(evidence).length > 0 ? { evidence } : {}) },
      tags: ["check", "caveat", "auto_surfaced"],
    } as FindingEntry);
    issues.push({
      kind: "undeclared_failed_check",
      name: base,
      detail: `results carries ${key} = false with no declared check behind it — auto-surfaced as a failed check; the analysis should declare_check("${base}", ...) beside the computation`,
    });
  }
  return { added, issues };
}

/**
 * Significance contradicted (run dfe3ea32): the narrative asserted "differs
 * at a statistically significant level" over a heterogeneity claim whose
 * significant field is FALSE (p = 0.240). Value-aware and line-scoped like
 * lintSignedLanguage: fires when a sentence claims statistical significance
 * while a finding BOUND IN THAT LINE carries significant: false — or denies
 * it over significant: true. Registered in the compose SEVERE set: a false
 * significance claim is a fabricated verdict, not a style issue, so it
 * earns the bounded repair pass.
 */
export function lintSignificanceMismatch(
  rawLine: string,
  lookup: { findings?: ReadonlyMap<string, unknown> }
): FindingIssue[] {
  if (!rawLine.includes("$finding:")) return [];
  const ASSERTS =
    /\bstatistically\s+significant\b|\bsignificant\s+(?:difference|level|divergence)\b/i;
  const DENIES =
    /\b(?:not|no)\s+(?:\w+\s+){0,2}statistically\s+significant\b|\bstatistically\s+insignificant\b/i;
  const asserts = ASSERTS.test(rawLine) && !DENIES.test(rawLine);
  const denies = DENIES.test(rawLine);
  if (!asserts && !denies) return [];
  const issues: FindingIssue[] = [];
  for (const m of rawLine.matchAll(/\$finding:([a-zA-Z0-9_]+)/g)) {
    const base = m[1];
    const value = lookup.findings?.get(base);
    if (value === null || typeof value !== "object") continue;
    const sig = (value as Record<string, unknown>).significant;
    if (typeof sig !== "boolean") continue;
    if (asserts && sig === false) {
      issues.push({
        kind: "significance_mismatch",
        name: base,
        detail: `narrative claims statistical significance beside ${base}, whose computed significant field is FALSE — state the non-significance or drop the claim`,
      });
    } else if (denies && sig === true) {
      issues.push({
        kind: "significance_mismatch",
        name: base,
        detail: `narrative denies statistical significance beside ${base}, whose computed significant field is TRUE`,
      });
    }
    break; // one verdict per line — the bound heterogeneity claim owns it
  }
  return issues;
}

/**
 * Disagreeing outlier detectors (run dfe3ea32): outlier_transaction_review
 * flagged 89 of 130 transactions while amount_outliers (rolling-MAD, k=3.5)
 * flagged 21 on the same data — a 4.2× disagreement, unreconciled. The
 * code-gen contract already forbids a second ad-hoc detector ("outlier
 * exclusion must reuse the SAME threshold family"); this makes a violation
 * visible. Fires when two result families whose names contain "outlier"
 * report n_flagged counts differing by ≥ 2×.
 */
export function lintOutlierDetectorDisagreement(results: Record<string, unknown>): FindingIssue[] {
  const counts: Array<[string, number]> = [];
  for (const [k, v] of Object.entries(results ?? {})) {
    if (!/outlier/i.test(k) || !/n_flagged$|_count$/.test(k)) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) continue;
    const family = k.replace(/_(n_flagged|count)$/, "");
    // One entry per family — n_flagged wins over _count when both exist.
    const existing = counts.findIndex(([f]) => f === family);
    if (existing >= 0) {
      if (k.endsWith("n_flagged")) counts[existing] = [family, v];
      continue;
    }
    counts.push([family, v]);
  }
  if (counts.length < 2) return [];
  const nonZero = counts.filter(([, n]) => n > 0);
  if (nonZero.length < 2) return [];
  const sorted = [...nonZero].sort((a, b) => a[1] - b[1]);
  const [minF, minN] = sorted[0];
  const [maxF, maxN] = sorted[sorted.length - 1];
  if (maxN / minN < 2) return [];
  return [
    {
      kind: "outlier_detector_disagreement",
      name: maxF,
      detail: `two outlier detectors disagree ${(maxN / minN).toFixed(1)}×: ${maxF} flagged ${maxN} vs ${minF} flagged ${minN} — one outlier policy per column (the contract's threshold-family rule); reconcile or drop the second detector`,
    },
  ];
}

/**
 * Share-basis mismatch (run 9c415dc8, audit high): the narrative wrote "45
 * amounting to 34.6% of spend" around evidence.other_share_pct — which is
 * 45/130, a share of TRANSACTION COUNT. The declared spend share for the
 * same label ("Other" in category_spend_shares.shares_pct) is 23.5%. The
 * values-blind planner guessed the basis; nothing in the field name stated
 * one.
 *
 * Value-aware and line-scoped like lintSignificanceMismatch: fires when a
 * sentence asserts a basis noun ("of spend") around a bound share/pct field
 * whose value MATERIALLY disagrees with a declared shares mapping that (a)
 * carries that basis word in its claim name and (b) holds an entry for the
 * same group label. Registered in the compose SEVERE set — a wrong-basis
 * share overstates concentration by construction, not by style.
 */
const BASIS_NOUN =
  /\bof\s+(?:the\s+|total\s+|all\s+)*(spend|spending|revenue|sales|dollars|amount|transactions?|records?|rows?|count)\b/i;

export function lintShareBasisMismatch(rawLine: string, findings: FindingEntry[]): FindingIssue[] {
  if (!rawLine.includes("$finding:")) return [];
  const issues: FindingIssue[] = [];
  const byName = new Map(findings.map((f) => [f.name, f]));
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  for (const m of rawLine.matchAll(/\$finding:([a-zA-Z0-9_.]+)/g)) {
    const path = m[1];
    const lastSeg = path.split(".").pop() ?? "";
    if (!/(share|pct|percent)/i.test(lastSeg)) continue;
    const owner = names.find((n) => path === n || path.startsWith(`${n}.`));
    if (!owner) continue;
    let v: unknown = byName.get(owner)!.value;
    for (const seg of path.slice(owner.length).replace(/^\./, "").split(".").filter(Boolean)) {
      v = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[seg] : undefined;
    }
    if (typeof v !== "number") continue;
    const start = Math.max(0, (m.index ?? 0) - 40);
    const window = rawLine.slice(start, (m.index ?? 0) + m[0].length + 60);
    const basis = BASIS_NOUN.exec(window)?.[1]?.toLowerCase();
    if (!basis) continue;
    // The group label the field is a share OF: its name segments minus the
    // share vocabulary ("evidence.other_share_pct" → "other").
    const labelTokens = lastSeg
      .split("_")
      .filter((t) => t.length > 2 && !/^(share|pct|percent|ratio|evidence)$/i.test(t));
    if (labelTokens.length === 0) continue;
    for (const f of findings) {
      if (f.name === owner) continue;
      // Only a shares claim whose NAME carries the asserted basis word can
      // adjudicate ("of spend" ↔ category_spend_shares).
      if (!f.name.toLowerCase().includes(basis.replace(/s$/, ""))) continue;
      const fv = f.value;
      if (fv === null || typeof fv !== "object" || Array.isArray(fv)) continue;
      const shares = (fv as Record<string, unknown>).shares_pct;
      if (shares === null || typeof shares !== "object" || Array.isArray(shares)) continue;
      for (const [label, pct] of Object.entries(shares as Record<string, unknown>)) {
        if (typeof pct !== "number") continue;
        const lab = label.toLowerCase();
        if (!labelTokens.some((t) => lab.includes(t.toLowerCase()))) continue;
        if (Math.abs(v - pct) > 3) {
          issues.push({
            kind: "share_basis_mismatch",
            name: owner,
            detail: `narrative asserts "${basis}" as the basis of ${path} (${v}), but ${f.name} declares the ${basis} share of "${label}" as ${pct} — the bound figure is a share of something else (likely a count); drop the basis word or bind the declared share`,
          });
          return issues; // one verdict per line
        }
      }
    }
  }
  return issues;
}

/**
 * Symmetric subset dedup of surfaced check/screen twins (run 9c415dc8): the
 * in-surfacer dedup compares (n_flagged, method), so a POORER twin that
 * lacks the method key dodges it — spend_outlier_evidence_{passed,n_flagged}
 * surfaced beside spend_outlier_screen_* and the banner said 3 failures
 * while only 2 caveats rendered (the planner skipped the duplicate, which
 * then sat in unnarratedFindings). Run AFTER both surfacers: an
 * auto-surfaced entry whose evidence is a SUBSET of a check/screen
 * sibling's — equal on every shared key, n_flagged present and equal, at
 * least one substantive name token shared — is the same computation under
 * a poorer name. Only auto-surfaced entries are ever dropped; a
 * model-declared claim is never removed by a lint.
 */
export function dedupeSurfacedTwins(findings: FindingEntry[]): {
  removed: string[];
  issues: FindingIssue[];
} {
  const evOf = (f: FindingEntry): Record<string, unknown> | null => {
    const v = f.value;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
    const rec = v as Record<string, unknown>;
    const ev =
      rec.evidence !== null && typeof rec.evidence === "object" && !Array.isArray(rec.evidence)
        ? (rec.evidence as Record<string, unknown>)
        : rec;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(ev)) {
      if (k !== "passed" && (val === null || typeof val !== "object")) out[k] = val;
    }
    return out;
  };
  const tokens = (name: string) => new Set(name.split(/[._]/).filter((t) => t.length > 3));
  const checkLike = findings.filter((f) => SCREEN_LIKE_DTYPES.has(f.dtype) && evOf(f) !== null);
  const removed: string[] = [];
  const issues: FindingIssue[] = [];
  for (const a of checkLike) {
    if (!a.tags?.includes("auto_surfaced")) continue;
    const evA = evOf(a)!;
    if (typeof evA.n_flagged !== "number") continue;
    const ta = tokens(a.name);
    for (const b of checkLike) {
      if (b === a || removed.includes(b.name)) continue;
      const evB = evOf(b)!;
      if (evB.n_flagged !== evA.n_flagged) continue;
      if (![...tokens(b.name)].some((t) => ta.has(t))) continue;
      const keysA = Object.keys(evA);
      const subset = keysA.every((k) => k in evB && evB[k] === evA[k]);
      // Strict subset, or equal-evidence twin where the OTHER entry wins by
      // declaration (a declared twin always beats a surfaced one).
      const poorer =
        subset &&
        (keysA.length < Object.keys(evB).length ||
          (keysA.length === Object.keys(evB).length && !b.tags?.includes("auto_surfaced")));
      if (poorer) {
        removed.push(a.name);
        issues.push({
          kind: "duplicate_screen_family",
          name: a.name,
          detail: `${a.name} duplicates ${b.name} (same n_flagged ${String(evA.n_flagged)}, evidence a subset of its) — one computation surfaced under two names; the poorer twin is dropped`,
        });
        break;
      }
    }
  }
  return { removed, issues };
}

/**
 * Mislabeled average (run 9c415dc8, audit medium): results carried
 * avg_transaction_spend_usd = 16.64 — the distribution's MEDIAN — beside
 * mean_transaction_spend_usd = 37.28, two "averages" disagreeing 2×. A key
 * whose name promises a mean but whose value equals a declared median (and
 * not the mean) is a mislabeled statistic waiting to anchor a wrong
 * sentence. Deterministic against declared distribution claims; advisory.
 */
export function lintMislabeledAverage(
  results: Record<string, unknown>,
  findings: FindingEntry[]
): FindingIssue[] {
  const closeTo = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.02, Math.abs(b) * 0.005);
  const dists = findings
    .map((f) => ({ name: f.name, v: f.value as Record<string, unknown> | null }))
    .filter(
      (d) =>
        d.v !== null &&
        typeof d.v === "object" &&
        typeof d.v.median === "number" &&
        typeof d.v.mean === "number"
    ) as Array<{ name: string; v: { median: number; mean: number } }>;
  if (dists.length === 0) return [];
  const issues: FindingIssue[] = [];
  for (const [key, val] of Object.entries(results ?? {})) {
    if (!/(^|_)(avg|average|mean)(_|$)/.test(key) || typeof val !== "number") continue;
    for (const d of dists) {
      // Only material splits matter: a symmetric distribution's mean ≈ median
      // makes the label distinction moot.
      if (closeTo(d.v.mean, d.v.median)) continue;
      if (closeTo(val, d.v.median) && !closeTo(val, d.v.mean)) {
        issues.push({
          kind: "mislabeled_average",
          name: d.name,
          detail: `results.${key} = ${val} equals ${d.name}'s MEDIAN (${d.v.median}) while its mean is ${d.v.mean} — a median labeled as an average; rename the key or fix the computation`,
        });
        break;
      }
    }
  }
  return issues;
}

/**
 * Auto-surface undeclared SCREENS (run 5872407b): the question asked to
 * "identify outliers", the code ran a rolling-MAD screen and wrote its whole
 * result to bare results keys (spend_transaction_outliers_n_flagged: 17,
 * _method, _window, _k) — and no finding, sentence, or caveat ever mentioned
 * an outlier. surfaceUndeclaredFailedChecks catches `*_passed: false`; a
 * computed screen carries no verdict key, so it slipped through in its
 * PASSING form. Third variant of the computed-but-never-declared class.
 *
 * A results family with screen morphology — `<base>_n_flagged` (number)
 * beside `<base>_method` (string) — and no declared finding owning `<base>`
 * is surfaced as a screen entry. `passed` follows the contract's screen
 * semantics ("a screen that FOUND offenders reports passed=false with the
 * offenders as evidence"): n_flagged 0 → true, else false — so a screen
 * that flagged rows gets the banner and a CAVEAT like any failed check.
 * Families that carry their own `<base>_passed` key are left to
 * surfaceUndeclaredFailedChecks (one owner per family).
 */
export function surfaceUndeclaredScreens(
  results: Record<string, unknown>,
  findings: FindingEntry[]
): { added: FindingEntry[]; issues: FindingIssue[] } {
  const added: FindingEntry[] = [];
  const issues: FindingIssue[] = [];
  const declared = findings.map((f) => f.name);
  for (const [key, value] of Object.entries(results ?? {})) {
    if (!key.endsWith("_n_flagged")) continue;
    const base = key.slice(0, -"_n_flagged".length);
    if (!base || !/^[a-z][a-z0-9_]*$/.test(base)) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    const method = results[`${base}_method`];
    if (typeof method !== "string") continue;
    if (`${base}_passed` in results) continue; // the checks surfacer owns it
    if (declared.some((d) => key.startsWith(`${d}_`) || d === base)) continue;
    // Evidence-equality dedup (run 31c1cfa9): the model wrote ONE rolling-MAD
    // screen into TWO results families — spend_outlier_screen_* (verdict key
    // → checks surfacer) and spend_outliers_* (screen morphology → here).
    // Both surfaced: "3 data checks failed" and two near-identical caveats
    // for one computation. Identical (n_flagged, method) against any finding
    // already in the manifest — declared or surfaced — is the same
    // computation under a second name: skip it, tell the model off.
    const twin = findings.find((f) => {
      const v = f.value;
      if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
      const rec = v as Record<string, unknown>;
      const ev =
        rec.evidence !== null && typeof rec.evidence === "object" && !Array.isArray(rec.evidence)
          ? (rec.evidence as Record<string, unknown>)
          : rec;
      return ev.n_flagged === value && ev.method === method;
    });
    if (twin) {
      issues.push({
        kind: "duplicate_screen_family",
        name: base,
        detail: `results family ${base}_* duplicates the screen already carried by ${twin.name} (same n_flagged ${value}, same method "${method}") — one computation written under two names; declare the screen once`,
      });
      continue;
    }
    const evidence: Record<string, unknown> = {};
    for (const [k2, v2] of Object.entries(results)) {
      if (!k2.startsWith(`${base}_`)) continue;
      const field = k2.slice(base.length + 1);
      if (v2 === null || typeof v2 !== "object") evidence[field] = v2;
    }
    added.push({
      name: base,
      dtype: "screen",
      definition: "An outlier screen the analysis ran on this data flagged one or more values",
      value: { passed: value === 0, evidence },
      tags: ["check", "caveat", "auto_surfaced"],
    } as FindingEntry);
    issues.push({
      kind: "undeclared_screen_computation",
      name: base,
      detail: `results carries a computed screen (${key} = ${value}, method ${method}) with no declared finding behind it — the analysis should declare it via finding_outliers + declare_finding`,
    });
  }
  return { added, issues };
}
