/**
 * Findings coherence lints (spec §3.3, §7.2, §7.3) — pure, advisory.
 *
 * The posture matters more than the checks: entries are KEPT and flagged.
 * A wrong-but-visible verdict beats a silently dropped one.
 */
import type { FindingEntry, FindingIssue } from "@/lib/contracts/findings";
import { STEP_QUALIFIED_RE } from "./validate";

/**
 * §3.3 derivation consistency:
 *  - every derived_from_findings ref must resolve (advisory "unresolved
 *    lineage" otherwise);
 *  - a verdict-like value derived from a decomposition must agree with the
 *    decomposition's dominant term (the run-4 lint: "amplifying" beside an
 *    86.6%-rate-driven split).
 *
 * Verdict-likeness and dominance are detected STRUCTURALLY (string value
 * derived from an entry whose value carries a `dominant` field) — no dtype
 * enum, per the open-vocabulary rule.
 */
export function lintDerivations(findings: FindingEntry[]): FindingIssue[] {
  const issues: FindingIssue[] = [];
  const byName = new Map(findings.map((f) => [f.name, f]));

  for (const f of findings) {
    for (const ref of f.derived_from_findings ?? []) {
      const bare = STEP_QUALIFIED_RE.test(ref) ? undefined : ref;
      const target = byName.get(ref) ?? (bare ? byName.get(bare) : undefined);
      if (!target) {
        issues.push({
          kind: "unresolved_lineage",
          name: f.name,
          detail: `derived_from_findings references unknown "${ref}"`,
        });
        continue;
      }
      // Dominant-term agreement: string verdict vs a source's `dominant`.
      if (typeof f.value === "string" && target.value && typeof target.value === "object") {
        const dominant = (target.value as Record<string, unknown>).dominant;
        if (typeof dominant === "string") {
          const verdict = f.value.toLowerCase();
          const dom = dominant.toLowerCase();
          // Contradiction heuristic, deliberately narrow: the verdict names
          // a term of the decomposition that is NOT the dominant one.
          const terms = Object.keys(target.value as Record<string, unknown>)
            .filter((k) => k !== "dominant")
            .map((k) => k.toLowerCase());
          const named = terms.find((t) => verdict.includes(t));
          if (named && named !== dom && !verdict.includes(dom)) {
            issues.push({
              kind: "derivation_contradiction",
              name: f.name,
              detail: `verdict "${f.value}" names non-dominant term "${named}" of ${target.name} (dominant: "${dominant}")`,
            });
          }
        }
      }
    }
  }
  return issues;
}

/**
 * §7.2 — investigate DAG check: a step-qualified derivation must point at a
 * step in the declaring step's depends_on set (1-based step_N ↔ 0-based
 * planner index: N-1 ∈ depends_on).
 */
export function lintCrossStepDerivations(
  findings: FindingEntry[],
  declaringStepNo: number,
  dependsOn: number[]
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  const allowed = new Set(dependsOn);
  for (const f of findings) {
    for (const ref of f.derived_from_findings ?? []) {
      const m = STEP_QUALIFIED_RE.exec(ref);
      if (!m) continue;
      const refStepNo = Number(m[1]);
      if (refStepNo === declaringStepNo) continue; // self-step, bare-equivalent
      if (!allowed.has(refStepNo - 1)) {
        issues.push({
          kind: "derivation_outside_dag",
          name: f.name,
          detail: `derives from step ${refStepNo} which is not in depends_on (${dependsOn.map((d) => d + 1).join(", ") || "none"}) — hallucinated lineage or missing dependency`,
        });
      }
    }
  }
  return issues;
}

/**
 * §7.3 — cross-step reconciliation: entries from DIFFERENT steps with the
 * same dtype+unit whose definitions reference overlapping columns, with
 * materially different numeric values, need reconciling in the synthesis.
 * Conservative: numeric scalars only; >5% relative difference; overlapping
 * derived_from_columns (definitions alone are too fuzzy to compare).
 */
export function lintCrossStepReconciliation(
  namespaced: Array<FindingEntry & { name: string }>
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  const scalars = namespaced.filter(
    (f) => typeof f.value === "number" && STEP_QUALIFIED_RE.test(f.name)
  );
  for (let i = 0; i < scalars.length; i++) {
    for (let j = i + 1; j < scalars.length; j++) {
      const a = scalars[i];
      const b = scalars[j];
      const stepA = STEP_QUALIFIED_RE.exec(a.name)![1];
      const stepB = STEP_QUALIFIED_RE.exec(b.name)![1];
      if (stepA === stepB) continue;
      if (a.dtype !== b.dtype || (a.unit ?? "") !== (b.unit ?? "")) continue;
      const colsA = new Set(a.derived_from_columns ?? []);
      const overlap = (b.derived_from_columns ?? []).some((c) => colsA.has(c));
      if (!overlap) continue;
      const va = a.value as number;
      const vb = b.value as number;
      const denom = Math.max(Math.abs(va), Math.abs(vb));
      if (denom === 0) continue;
      if (Math.abs(va - vb) / denom > 0.05) {
        issues.push({
          kind: "cross_step_reconciliation",
          name: a.name,
          detail: `${a.name} (${va}) and ${b.name} (${vb}) measure overlapping columns with the same dtype/unit but differ materially — the synthesis must reconcile or scope them`,
        });
      }
    }
  }
  return issues;
}

// ── Unit-phrase lint (post-compose, pre-resolution) ──────────────────

const PERCENT_WORDS = /percentage\s*points?|\bpp\b|\bpercent(?:age)?\b|%/i;
const RATIO_WORDS = /\bratio\b|\bfraction\b|\bproportion\b/i;
const RATIO_UNIT = /^(ratio|fraction|proportion)$/i;
const PERCENT_UNIT = /^(pp|percentage\s*points?|%|percent|pct)$/i;

/**
 * Detect prose that RE-UNITS a bound finding: the manifest declares
 * unit "ratio" and the sentence wraps the placeholder in "percentage
 * points" (or the inverse). The bound VALUE is correct — the words around
 * it are off by 100×, which reads as "essentially flat" for a series that
 * tripled. Scans the PRE-resolution composer line (the $finding token is
 * still present, so the window is anchored to the exact binding).
 * Advisory: issues feed grounding caveats, never rewrite the spec.
 */
export function lintUnitPhrase(
  rawLine: string,
  unitByName: ReadonlyMap<string, string>
): FindingIssue[] {
  if (!rawLine.includes("$finding:")) return [];
  const issues: FindingIssue[] = [];
  for (const m of rawLine.matchAll(/\$finding:([a-zA-Z0-9_.]+)/g)) {
    // Full token first, then with a trailing .field stripped — handles both
    // "name.value" and step-qualified "step_2.name.value".
    const name = unitByName.has(m[1]) ? m[1] : m[1].replace(/\.[a-zA-Z0-9_]+$/, "");
    const unit = unitByName.get(name);
    if (!unit) continue;
    const start = Math.max(0, (m.index ?? 0) - 60);
    const window = rawLine.slice(start, (m.index ?? 0) + m[0].length + 60);
    if (RATIO_UNIT.test(unit) && PERCENT_WORDS.test(window)) {
      issues.push({
        kind: "unit_mismatch",
        name,
        detail: `narrative describes ${name} (declared unit "${unit}") in percentage terms — the surrounding words re-unit the bound value (a 0.009 ratio is 0.9 pp; 100\u00d7 off)`,
      });
    } else if (PERCENT_UNIT.test(unit) && RATIO_WORDS.test(window) && !PERCENT_WORDS.test(window)) {
      issues.push({
        kind: "unit_mismatch",
        name,
        detail: `narrative describes ${name} (declared unit "${unit}") as a ratio/fraction — the surrounding words contradict the declared unit`,
      });
    }
  }
  return issues;
}

// ── Sentinel-interpolation lint ──────────────────────────────────────

const SENTINEL_STRINGS = new Set(["none", "n/a", "na", "null", ""]);

function isSentinelValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "boolean") return true;
  if (typeof v === "string") return SENTINEL_STRINGS.has(v.trim().toLowerCase());
  return false;
}

function renderedForm(v: unknown): string {
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (v === null || v === undefined) return "null";
  return String(v);
}

function descend(root: unknown, path: string[]): unknown {
  let cur = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Detect a sentinel or boolean value bound INLINE into prose — the
 * "Segment churn rates are Yes across the year" / "the customer base size
 * none the headline" class. The composer is values-blind, so it cannot
 * know a flag resolves to Yes/No or "none"; the server CAN, at compose
 * time, before resolution. A token is inline when its host JSON string
 * carries other words (a whole-value StatCard binding of a boolean is
 * legitimate — "Yes" as a stat value reads fine).
 * Advisory: feeds grounding caveats, never rewrites the spec.
 */
export function lintSentinelInterpolation(
  rawLine: string,
  lookup: {
    findings?: ReadonlyMap<string, unknown>;
    results?: Readonly<Record<string, unknown>>;
  }
): FindingIssue[] {
  if (!rawLine.includes("$finding:") && !rawLine.includes("$result:")) return [];
  const issues: FindingIssue[] = [];
  for (const strMatch of rawLine.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    const str = strMatch[1];
    const tokens = [...str.matchAll(/\$(finding|result):([a-zA-Z0-9_.]+)/g)];
    if (tokens.length === 0) continue;
    // Inline = the string still contains letters once every token is removed.
    const residue = tokens.reduce((acc, t) => acc.replace(t[0], ""), str);
    if (!/[a-zA-Z]/.test(residue)) continue;
    for (const t of tokens) {
      const [, kind, ref] = t;
      let value: unknown;
      if (kind === "finding") {
        const map = lookup.findings;
        if (!map) continue;
        if (map.has(ref)) value = map.get(ref);
        else {
          const base = ref.replace(/\.[a-zA-Z0-9_]+$/, "");
          const field = ref.slice(base.length + 1);
          value = map.has(base) ? descend(map.get(base), [field]) : undefined;
        }
      } else {
        value = descend(lookup.results ?? {}, ref.split("."));
      }
      if (value === undefined || !isSentinelValue(value)) continue;
      issues.push({
        kind: "sentinel_interpolation",
        name: ref,
        detail: `narrative interpolates $${kind}:${ref} mid-sentence, but it resolves to "${renderedForm(value)}" — a flag/sentinel in a word slot reads as broken prose; gate the sentence with $cond or state the fact explicitly`,
      });
    }
  }
  return issues;
}

// ── Missing-linkage lint (run-10: "ten for ten") ─────────────────────

/**
 * A step-change finding and a per-group trends finding in the same manifest
 * jointly imply an attribution ("which group drove the step") — but a
 * values-blind composer cannot COMPUTE that link, only bind it. When no
 * finding derives from both, the most decision-relevant sentence in the run
 * is unwritable. Detection is STRUCTURAL (no dtype vocabulary): step-shaped
 * = value carries period+delta fields; group-shaped = value is a dict of
 * ≥2 sub-objects sharing a numeric field.
 */
export function lintMissingLinkage(findings: FindingEntry[]): FindingIssue[] {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  const stepish = findings.filter(
    (f) => isObj(f.value) && "period" in f.value && "delta" in f.value
  );
  const groupish = findings.filter((f) => {
    if (!isObj(f.value)) return false;
    const children = Object.values(f.value).filter(isObj);
    if (children.length < 2) return false;
    const first = children[0];
    return Object.keys(first).some((k) => children.every((c) => typeof c[k] === "number"));
  });
  if (stepish.length === 0 || groupish.length === 0) return [];
  const stepNames = new Set(stepish.map((f) => f.name));
  const groupNames = new Set(groupish.map((f) => f.name));
  const linked = findings.some((f) => {
    const refs = f.derived_from_findings ?? [];
    return refs.some((r) => stepNames.has(r)) && refs.some((r) => groupNames.has(r));
  });
  if (linked) return [];
  return [
    {
      kind: "missing_linking_finding",
      name: stepish[0].name,
      detail: `${stepish[0].name} and ${groupish[0].name} are declared but no finding derives from both — the attribution linking them is computable and undeclared, so the narrative cannot state it`,
    },
  ];
}

// ── Signed-language lint (run-11: "-23.8M ... sharpest acceleration") ──

const POSITIVE_WORDS =
  /accelerat|jump|surge|spike|increas|\brise\b|\brose\b|\bgain|growth|climb|\bup\b/i;
const NEGATIVE_WORDS = /declin|\bdrop|\bfell\b|\bfall|decreas|contract|plunge|shrink|\bdown\b/i;

/**
 * A negative bound value narrated with positive-direction words (a -46%
 * month-over-month decline called "the sharpest acceleration") — or the
 * inverse. The composer is values-blind, so sign-appropriate language can
 * only be checked here. Window-scoped like lintUnitPhrase; advisory only.
 */
export function lintSignedLanguage(
  rawLine: string,
  lookup: {
    findings?: ReadonlyMap<string, unknown>;
    results?: Readonly<Record<string, unknown>>;
  }
): FindingIssue[] {
  if (!rawLine.includes("$finding:") && !rawLine.includes("$result:")) return [];
  const issues: FindingIssue[] = [];
  for (const m of rawLine.matchAll(/\$(finding|result):([a-zA-Z0-9_.]+)/g)) {
    const [, kind, ref] = m;
    let value: unknown;
    if (kind === "finding") {
      const map = lookup.findings;
      if (!map) continue;
      if (map.has(ref)) value = map.get(ref);
      else {
        const base = ref.replace(/\.[a-zA-Z0-9_]+$/, "");
        const field = ref.slice(base.length + 1);
        const parent = map.get(base);
        value =
          parent && typeof parent === "object"
            ? (parent as Record<string, unknown>)[field]
            : undefined;
      }
    } else {
      let cur: unknown = lookup.results ?? {};
      for (const seg of ref.split(".")) {
        if (cur === null || typeof cur !== "object") {
          cur = undefined;
          break;
        }
        cur = (cur as Record<string, unknown>)[seg];
      }
      value = cur;
    }
    if (typeof value !== "number" || value === 0) continue;
    // Only fields that MEASURE change carry a sign worth checking — a year
    // (1856) or a count (menus_covered: 5) near the word "decrease" is not
    // a sign mismatch (run-24 false positives).
    const lastSeg = ref.split(".").pop() ?? ref;
    if (
      !/delta|change|slope|growth|diff|pct|effect|shift|net|trend|rise|fall|drop|declin|increas|decreas/i.test(
        lastSeg
      )
    )
      continue;
    const start = Math.max(0, (m.index ?? 0) - 60);
    const window = rawLine.slice(start, (m.index ?? 0) + m[0].length + 60);
    if (value < 0 && POSITIVE_WORDS.test(window) && !NEGATIVE_WORDS.test(window)) {
      issues.push({
        kind: "sign_mismatch",
        name: ref,
        detail: `narrative uses positive-direction language around ${ref}, which is NEGATIVE (${value}) — a decline described as an acceleration/jump`,
      });
    } else if (value > 0 && NEGATIVE_WORDS.test(window) && !POSITIVE_WORDS.test(window)) {
      issues.push({
        kind: "sign_mismatch",
        name: ref,
        detail: `narrative uses negative-direction language around ${ref}, which is POSITIVE (${value})`,
      });
    }
  }
  return issues;
}

// ── Granularity-conflict lint (run-14: monthly rising vs quarterly flat) ──

/**
 * Two findings about the SAME measure (>= 2 shared name tokens) whose values
 * both carry a direction string that DISAGREES — usually the same series at
 * two granularities ("rising" monthly, "flat" quarterly). Both labels
 * reaching the reader unreconciled is a contradiction to them; the composer
 * must scope or reconcile. Advisory.
 */
export function lintGranularityConflict(findings: FindingEntry[]): FindingIssue[] {
  const dirOf = (f: FindingEntry): string | undefined => {
    const v = f.value;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
    const d = (v as Record<string, unknown>).direction;
    return typeof d === "string" ? d : undefined;
  };
  const tokens = (name: string) => new Set(name.split(/[._]/).filter((t) => t.length > 2));
  const directional = findings
    .map((f) => ({ f, dir: dirOf(f) }))
    .filter((x): x is { f: FindingEntry; dir: string } => x.dir !== undefined && x.dir !== "");
  const issues: FindingIssue[] = [];
  for (let i = 0; i < directional.length; i++) {
    for (let j = i + 1; j < directional.length; j++) {
      const a = directional[i];
      const b = directional[j];
      if (a.dir.toLowerCase() === b.dir.toLowerCase()) continue;
      const ta = tokens(a.f.name);
      const shared = [...tokens(b.f.name)].filter((t) => ta.has(t));
      if (shared.length < 2) continue;
      issues.push({
        kind: "granularity_conflict",
        name: a.f.name,
        detail: `${a.f.name} says "${a.dir}" while ${b.f.name} says "${b.dir}" for the same measure — the narrative must reconcile or scope them (a significance-test "flat" means not-significant at that granularity, not no growth)`,
      });
    }
  }
  return issues;
}

// ── Completeness-conflict lint (structural fix 1, 2026-08-07) ────────

interface EdgeProfile {
  trailing_incomplete?: Array<{
    period?: unknown;
    coverage?: unknown;
    baseline_coverage?: unknown;
  }>;
}

/**
 * The platform profiler found trailing incomplete periods, but an
 * ending-state-shaped finding (value carries excluded_trailing) excluded
 * NOTHING — the generated code ran its completeness test at a grain that
 * erased the signal (4 consecutive runs of excluded_trailing: 0 against a
 * 231 -> 3 coverage collapse). Advisory; also fires when no ending-state
 * finding exists at all but the edge is dirty.
 */
export function lintCompletenessConflict(
  findings: FindingEntry[],
  completeness: unknown
): FindingIssue[] {
  const prof = completeness as EdgeProfile | null | undefined;
  const trailing = prof?.trailing_incomplete;
  if (!Array.isArray(trailing) || trailing.length === 0) return [];
  const endingState = findings.filter(
    (f) =>
      f.value !== null &&
      typeof f.value === "object" &&
      !Array.isArray(f.value) &&
      "excluded_trailing" in (f.value as Record<string, unknown>)
  );
  const last = trailing[trailing.length - 1];
  const edge = `platform profiler: ${trailing.length} trailing period(s) have collapsed coverage (last: ${String(last?.period)} at ${String(last?.coverage)} of ${String(last?.baseline_coverage)} contributors)`;
  const conflicted = endingState.filter(
    (f) => (f.value as Record<string, unknown>).excluded_trailing === 0
  );
  if (conflicted.length > 0) {
    return conflicted.map((f) => ({
      kind: "completeness_conflict",
      name: f.name,
      detail: `${f.name} excluded no trailing periods but the ${edge} — its completeness test ran at a grain that erased the signal; ending-state figures overstate the edge`,
    }));
  }
  if (endingState.length === 0) {
    return [
      {
        kind: "completeness_conflict",
        detail: `${edge} — no finding accounts for it; recent-period figures include incomplete data`,
      },
    ];
  }
  return [];
}

// ── Range-fabrication + trend-contract lints (menu run, 2026-08-07) ──

const STANDARD_DIRECTIONS = new Set(["rising", "falling", "flat", "up", "down"]);

/**
 * Trend-contract violations: a direction that is not a direction word
 * ("regime_change" in a direction slot breaks the rising/falling/flat
 * contract every consumer assumes), and a non-flat direction narrated
 * beside an insignificant fit (p = 0.994 means NO detectable trend — the
 * slope describes nothing). Advisory.
 */
export function lintTrendContract(findings: FindingEntry[]): FindingIssue[] {
  const issues: FindingIssue[] = [];
  for (const f of findings) {
    const v = f.value;
    if (v === null || typeof v !== "object" || Array.isArray(v)) continue;
    const rec = v as Record<string, unknown>;
    const dir = rec.direction;
    if (typeof dir !== "string" || dir === "") continue;
    if (!STANDARD_DIRECTIONS.has(dir.toLowerCase())) {
      issues.push({
        kind: "nonstandard_direction",
        name: f.name,
        detail: `${f.name} declares direction "${dir}" — not a direction word (rising/falling/flat); hand-assigned instead of taken from finding_trend`,
      });
      continue;
    }
    const p = rec.p_value;
    if (typeof p === "number" && p > 0.05 && dir.toLowerCase() !== "flat") {
      issues.push({
        kind: "insignificant_trend_direction",
        name: f.name,
        detail: `${f.name} declares "${dir}" with p = ${p} — an insignificant fit is "flat"; the slope describes nothing at this granularity`,
      });
    }
  }
  return issues;
}

/**
 * Fabricated framing: a finding definition citing years OUTSIDE the
 * platform-profiled data range ("over 1820-2020" on data spanning
 * 1851-2012 — invented periodisation presented as analysis structure).
 * Advisory; tolerates a 1-year edge slack.
 */
export function lintRangeFabrication(
  findings: FindingEntry[],
  completeness: unknown
): FindingIssue[] {
  const prof = completeness as { time_min?: unknown; time_max?: unknown } | null | undefined;
  const minY = Number(String(prof?.time_min ?? "").slice(0, 4));
  const maxY = Number(String(prof?.time_max ?? "").slice(0, 4));
  if (!Number.isFinite(minY) || !Number.isFinite(maxY) || minY < 1000 || maxY < 1000) return [];
  const issues: FindingIssue[] = [];
  for (const f of findings) {
    const years = [...f.definition.matchAll(/\b(1[6-9]\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));
    const outside = years.filter((y) => y < minY - 1 || y > maxY + 1);
    if (outside.length > 0) {
      issues.push({
        kind: "range_fabrication",
        name: f.name,
        detail: `${f.name} definition cites year(s) ${outside.join(", ")} outside the observed data range ${minY}-${maxY} — invented periodisation`,
      });
    }
  }
  return issues;
}

// ── Check-gating lints (declared-checks spec §3) ─────────────────────

const isCheck = (f: FindingEntry): boolean => f.dtype === "check";
const checkPassed = (f: FindingEntry): boolean | null => {
  if (f.value === null || typeof f.value !== "object" || Array.isArray(f.value)) return null;
  const p = (f.value as Record<string, unknown>).passed;
  return typeof p === "boolean" ? p : null;
};

/**
 * Declared-checks enforcement: a finding derived from a FAILED check rests
 * on an invalidated assumption; a failed blocking check with no dependent
 * findings is an unheeded red flag; a check with passed but zero evidence
 * keys is self-graded. All advisory — the posture never fails a run.
 */
/** Presence backstop: findings with ZERO checks means the analysis never
 *  interrogated its own assumptions — every semantic decision is unvalidated. */
export function lintNoChecksDeclared(findings: FindingEntry[]): FindingIssue[] {
  const nonCheck = findings.filter((f) => f.dtype !== "check");
  const checks = findings.filter((f) => f.dtype === "check");
  if (nonCheck.length >= 4 && checks.length === 0) {
    return [
      {
        kind: "no_checks_declared",
        detail: `${nonCheck.length} findings declared with zero validating checks — the analysis never interrogated its own assumptions (grain, windows, model form, plausibility are all unvalidated)`,
      },
    ];
  }
  return [];
}

export function lintCheckGating(findings: FindingEntry[]): FindingIssue[] {
  const issues: FindingIssue[] = [];
  const checks = new Map(findings.filter(isCheck).map((f) => [f.name, f]));
  for (const f of findings) {
    if (isCheck(f)) {
      const v = f.value as Record<string, unknown> | null;
      const evidenceKeys =
        v && typeof v === "object" ? Object.keys(v).filter((k) => k !== "passed") : [];
      const hasNumericEvidence = evidenceKeys.some((k) => {
        const val = (v as Record<string, unknown>)[k];
        return (
          typeof val === "number" || (Array.isArray(val) && val.some((x) => typeof x === "number"))
        );
      });
      if (checkPassed(f) !== null && evidenceKeys.length === 0) {
        issues.push({
          kind: "weak_check",
          name: f.name,
          detail: `check ${f.name} declares passed=${String(checkPassed(f))} with NO computed evidence — a self-graded check validates nothing`,
        });
      } else if (checkPassed(f) !== null && !hasNumericEvidence) {
        // Run-32: a comparability check reduced to {split_method, series_used}
        // strings — evidence without numbers is a label, not a check.
        issues.push({
          kind: "weak_check",
          name: f.name,
          detail: `check ${f.name} carries no NUMERIC evidence (${evidenceKeys.join(", ")}) — method names and labels assert, they do not measure; report the n's/spans/thresholds the pass rests on`,
        });
      }
      continue;
    }
    for (const ref of f.derived_from_findings ?? []) {
      const check = checks.get(ref) ?? checks.get(ref.replace(/^step_\d+\./, ""));
      if (check && checkPassed(check) === false) {
        issues.push({
          kind: "rests_on_failed_check",
          name: f.name,
          detail: `${f.name} derives from FAILED check ${check.name} — the assumption it rests on did not validate; narrate only with the caveat bound`,
        });
      }
    }
  }
  for (const [name, check] of checks) {
    if (checkPassed(check) === false && check.tags?.includes("blocking")) {
      const heeded = findings.some(
        (f) => !isCheck(f) && (f.derived_from_findings ?? []).includes(name)
      );
      if (!heeded) {
        issues.push({
          kind: "unheeded_blocking_check",
          name,
          detail: `blocking check ${name} FAILED and no finding declares lineage from it — the analysis proceeded as if it passed`,
        });
      }
    }
  }
  return issues;
}

// ── Method-mismatch lint (3rd Kruskal-Wallis-vs-anova occurrence) ────

const TEST_WORDS = [
  "anova",
  "kruskal",
  "wallis",
  "mann-whitney",
  "t-test",
  "chi-square",
  "spearman",
  "pearson",
  "f-test",
];

/** A definition promising one statistical test while value.test records
 *  another is a fabricated method claim at the declaration layer. */
export function lintMethodMismatch(findings: FindingEntry[]): FindingIssue[] {
  const issues: FindingIssue[] = [];
  for (const f of findings) {
    if (f.value === null || typeof f.value !== "object" || Array.isArray(f.value)) continue;
    const test = (f.value as Record<string, unknown>).test;
    if (typeof test !== "string" || test === "") continue;
    const def = f.definition.toLowerCase();
    const promised = TEST_WORDS.filter((w) => def.includes(w));
    if (promised.length > 0 && !promised.some((w) => test.toLowerCase().includes(w))) {
      issues.push({
        kind: "method_mismatch",
        name: f.name,
        detail: `${f.name} definition promises "${promised.join("/")}" but value.test records "${test}" — the declared method and the computed method disagree`,
      });
    }
  }
  return issues;
}

// ── Null-ancestry lint (run-25: derived number from a null parent) ───

const isAllNullValue = (v: unknown): boolean => {
  if (v === null || v === undefined) return true;
  if (typeof v !== "object" || Array.isArray(v)) return false;
  const leaves = Object.values(v as Record<string, unknown>);
  return leaves.length > 0 && leaves.every((x) => x === null);
};

/** A finding with real values deriving from an all-null ancestor asserts a
 *  number its own lineage says was never computed ("prices moved 408.1%
 *  from the last complete observed year" — current_state was null). */
export function lintNullAncestry(findings: FindingEntry[]): FindingIssue[] {
  const byName = new Map(findings.map((f) => [f.name, f]));
  const issues: FindingIssue[] = [];
  for (const f of findings) {
    if (isAllNullValue(f.value)) continue;
    for (const ref of f.derived_from_findings ?? []) {
      const parent = byName.get(ref) ?? byName.get(ref.replace(/^step_\d+\./, ""));
      if (parent && isAllNullValue(parent.value)) {
        issues.push({
          kind: "derived_from_null",
          name: f.name,
          detail: `${f.name} carries values but derives from ${parent.name}, whose value is entirely null — the lineage it claims was never computed; do not narrate it as established`,
        });
      }
    }
  }
  return issues;
}

// ── Definition-contradicted lint (4 runs of min_price_boolean_flag) ──

/** A boolean evidence key `is_X: false` beside a definition that asserts X
 *  ("min_price is a boolean completeness flag" next to is_boolean: false)
 *  states a conclusion the computation denies. */
export function lintDefinitionContradicted(findings: FindingEntry[]): FindingIssue[] {
  const issues: FindingIssue[] = [];
  for (const f of findings) {
    if (f.value === null || typeof f.value !== "object" || Array.isArray(f.value)) continue;
    const def = f.definition.toLowerCase();
    for (const [k, v] of Object.entries(f.value as Record<string, unknown>)) {
      if (v !== false || !/^is_[a-z_]+$/.test(k)) continue;
      const phrase = k.slice(3).replace(/_/g, " ");
      if (
        def.includes(phrase) &&
        !def.includes(`not ${phrase}`) &&
        !def.includes(`non-${phrase}`)
      ) {
        issues.push({
          kind: "definition_contradicted",
          name: f.name,
          detail: `${f.name} definition asserts "${phrase}" while ${k}: false denies it — the prose states a conclusion the computation rejects`,
        });
      }
    }
  }
  return issues;
}

// ── Chart-consistency lint (run-30: null-vs-zero split across series) ──

/**
 * Two chart series in ONE payload disagreeing about the same (x, column)
 * cell — 1966 max_price null in price_trend_over_time and 10000 in
 * price_spread_over_time — is the screen applied to some series and not
 * others; and a peak/max superlative naming a smaller value than a chart
 * column beside it ships two answers. Deterministic, advisory.
 */
export function lintChartConsistency(
  chartData: Record<string, unknown>,
  findings: FindingEntry[]
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  // Cell map: column -> xValue -> {nulls: series[], values: Map<series, number>}
  const cells = new Map<string, Map<string, { nulls: string[]; nums: Map<string, number> }>>();
  const xKeyOf = (row: Record<string, unknown>): string | undefined => {
    for (const k of ["year", "month", "date", "period", "x", "label"]) {
      if (k in row) return String(row[k]);
    }
    return undefined;
  };
  for (const [series, v] of Object.entries(chartData)) {
    const rows = Array.isArray(v) ? v : (v as { rows?: unknown[] } | null)?.rows;
    if (!Array.isArray(rows)) continue;
    for (const raw of rows) {
      if (raw === null || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const x = xKeyOf(row);
      if (x === undefined) continue;
      for (const [col, val] of Object.entries(row)) {
        if (["year", "month", "date", "period", "x", "label"].includes(col)) continue;
        const byX = cells.get(col) ?? new Map();
        cells.set(col, byX);
        const cell = byX.get(x) ?? { nulls: [], nums: new Map() };
        byX.set(x, cell);
        if (val === null) cell.nulls.push(series);
        else if (typeof val === "number") cell.nums.set(series, val);
      }
    }
  }
  let divergences = 0;
  for (const [col, byX] of cells) {
    for (const [x, cell] of byX) {
      if (cell.nulls.length > 0 && cell.nums.size > 0 && divergences < 3) {
        divergences++;
        const [numSeries, num] = [...cell.nums.entries()][0];
        issues.push({
          kind: "chart_policy_divergence",
          detail: `${col} at ${x} is null in ${cell.nulls[0]} but ${num} in ${numSeries} — the same cell under two policies; a screen applied to some series and not others`,
        });
      }
    }
  }
  // Superlative vs chart max: a peak/max finding whose value a chart column exceeds.
  for (const f of findings) {
    if (!/peak|max/.test(f.name) || f.value === null || typeof f.value !== "object") continue;
    const val = (f.value as Record<string, unknown>).value;
    if (typeof val !== "number") continue;
    const tokens = f.name.split(/[._]/).filter((t) => t.length > 2 && !["peak", "max"].includes(t));
    for (const [col, byX] of cells) {
      if (!tokens.some((t) => col.includes(t))) continue;
      let best: { x: string; v: number } | null = null;
      for (const [x, cell] of byX) {
        for (const v of cell.nums.values()) {
          if (!best || v > best.v) best = { x, v };
        }
      }
      if (best && best.v > val * 1.05) {
        issues.push({
          kind: "superlative_contradicted_by_chart",
          name: f.name,
          detail: `${f.name} reports ${val} but chart column ${col} holds ${best.v} at ${best.x} — the finding and the chart beside it disagree about the maximum`,
        });
        break;
      }
    }
  }
  return issues;
}

// ── Results-provenance lint (run-31: superlative with no finding) ────

/** A superlative-shaped results scalar (peak_/trough_/max_/min_) with no
 *  finding sharing its name tokens has a broken provenance chain — the
 *  manifest exists so every headline value traces to a declared finding. */
export function lintResultsProvenance(
  results: Record<string, unknown>,
  findings: FindingEntry[]
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  const findingTokens = findings.map(
    (f) => new Set(f.name.split(/[._]/).filter((t) => t.length > 2))
  );
  for (const [key, val] of Object.entries(results)) {
    if (typeof val !== "number") continue;
    if (!/^(peak|trough|max|min|largest|smallest)_/.test(key)) continue;
    const toks = key.split(/[._]/).filter((t) => t.length > 2);
    const backed = findingTokens.some((ft) => toks.filter((t) => ft.has(t)).length >= 2);
    if (!backed && issues.length < 5) {
      issues.push({
        kind: "unbacked_superlative",
        detail: `results.${key} = ${val} has no finding backing it — a superlative shipped without the provenance the manifest exists to provide`,
      });
    }
  }
  return issues;
}

// ── Undeclared-screen lint (run-32: max_price screened, no contract) ──

/** A *_screened column in chart_data with no check declaring a screen over
 *  its base column: the parallel-columns contract eliminated consumer-side
 *  assumptions, but a screen with no declaration is a transformation with
 *  no contract behind it. */
export function lintUndeclaredScreen(
  chartData: Record<string, unknown>,
  findings: FindingEntry[]
): FindingIssue[] {
  const screenedBases = new Set<string>();
  for (const v of Object.values(chartData)) {
    const rows = Array.isArray(v) ? v : (v as { rows?: unknown[] } | null)?.rows;
    if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== "object") continue;
    for (const col of Object.keys(rows[0] as Record<string, unknown>)) {
      const m = /^(.*?)_screened(?:_[a-z]+)?$/.exec(col);
      if (m) screenedBases.add(m[1]);
    }
  }
  const issues: FindingIssue[] = [];
  for (const base of screenedBases) {
    const tokens = base.split(/_/).filter((t) => t.length > 2);
    const declared = findings.some(
      (f) =>
        f.dtype === "check" &&
        /screen|outlier|exclusion/.test(f.name + " " + f.definition.toLowerCase()) &&
        tokens.some((t) => f.name.includes(t) || f.definition.toLowerCase().includes(t))
    );
    if (!declared) {
      issues.push({
        kind: "undeclared_screen",
        detail: `chart_data carries ${base}_screened* columns but no check declares a screen over ${base} — a transformation with no declaration behind it (which rule, what threshold, how many excluded?)`,
      });
    }
  }
  return issues;
}

// ── Screen-scope mismatch + series-consumption lints (run-33) ────────

function screenedColumnMap(
  chartData: Record<string, unknown>
): Map<string, { excludedX: Set<string>; rawKeys: Set<string>; screenedKeys: Set<string> }> {
  const map = new Map<
    string,
    { excludedX: Set<string>; rawKeys: Set<string>; screenedKeys: Set<string> }
  >();
  const X_KEYS = ["year", "month", "date", "period", "x", "label", "decade"];
  for (const [key, v] of Object.entries(chartData)) {
    const rows = Array.isArray(v) ? v : (v as { rows?: unknown[] } | null)?.rows;
    if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== "object") continue;
    const cols = Object.keys(rows[0] as Record<string, unknown>);
    for (const col of cols) {
      const m = /^(.*?)_screened(_[a-z]+)?$/.exec(col);
      if (!m) continue;
      const base = m[1] + (m[2] ?? "");
      const entry = map.get(m[1]) ?? {
        excludedX: new Set<string>(),
        rawKeys: new Set<string>(),
        screenedKeys: new Set<string>(),
      };
      map.set(m[1], entry);
      entry.screenedKeys.add(key);
      const xCol = cols.find((c) => X_KEYS.includes(c.toLowerCase()));
      for (const raw of rows as Record<string, unknown>[]) {
        const baseVal = raw[base] ?? raw[m[1] + "_usd"] ?? raw[m[1]];
        if (baseVal !== null && baseVal !== undefined && raw[col] === null && xCol) {
          entry.excludedX.add(String(raw[xCol]));
        }
      }
    }
  }
  // Second pass: raw-only consumption — must run AFTER all screened bases
  // are known (a raw chart earlier in iteration order than its screened
  // sibling would otherwise be missed).
  for (const [key, v] of Object.entries(chartData)) {
    const rows = Array.isArray(v) ? v : (v as { rows?: unknown[] } | null)?.rows;
    if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== "object") continue;
    const cols = Object.keys(rows[0] as Record<string, unknown>);
    for (const col of cols) {
      if (/_screened/.test(col)) continue;
      const base = col.replace(/_(usd|pct|pp)$/, "");
      const entry = map.get(base);
      if (entry && !cols.some((c) => c.startsWith(base + "_screened"))) {
        entry.rawKeys.add(key);
      }
    }
  }
  return map;
}

/** The screen a *_screened column ACTUALLY applied (base non-null, screened
 *  null) must match the declared check's evidence set — {1966, 1980}
 *  applied against a declared {1980, 1999, 2012} is two exclusion sets
 *  under one manifest entry. */
export function lintScreenScopeMismatch(
  chartData: Record<string, unknown>,
  findings: FindingEntry[]
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  for (const [base, entry] of screenedColumnMap(chartData)) {
    if (entry.excludedX.size === 0) continue;
    const tokens = base.split(/_/).filter((t) => t.length > 2);
    const declaring = findings.filter(
      (f) =>
        f.dtype === "check" &&
        /screen|outlier|exclusion/.test(f.name + " " + f.definition.toLowerCase()) &&
        tokens.some((t) => f.name.includes(t) || f.definition.toLowerCase().includes(t))
    );
    if (declaring.length === 0) continue; // undeclared_screen covers that
    const declared = new Set<string>();
    for (const f of declaring) {
      const walk = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(walk);
        else if (typeof v === "number") declared.add(String(v));
        else if (typeof v === "string" && /^\d{3,4}$/.test(v)) declared.add(v);
        else if (v && typeof v === "object") Object.values(v).forEach(walk);
      };
      walk(f.value);
    }
    if (declared.size === 0) continue;
    const outside = [...entry.excludedX].filter((x) => !declared.has(x));
    if (outside.length > 0) {
      issues.push({
        kind: "screen_scope_mismatch",
        name: declaring[0].name,
        detail: `${base}_screened excludes {${[...entry.excludedX].join(", ")}} but ${declaring[0].name} declares {${[...declared].join(", ")}} — ${outside.join(", ")} excluded by no declared rule (two exclusion sets, one manifest entry)`,
      });
    }
  }
  return issues;
}

/** A chart consuming the RAW series while a screened sibling exists
 *  elsewhere is an undeclared choice that WILL drift between runs (the
 *  decade rollup silently flipping raw/screened moved the 1980s bar 10x). */
export function lintSeriesConsumption(chartData: Record<string, unknown>): FindingIssue[] {
  const issues: FindingIssue[] = [];
  for (const [base, entry] of screenedColumnMap(chartData)) {
    if (entry.rawKeys.size > 0 && entry.screenedKeys.size > 0 && issues.length < 4) {
      issues.push({
        kind: "undeclared_series_choice",
        detail: `${[...entry.rawKeys].join(", ")} consume(s) raw ${base} while screened ${base} exists (${[...entry.screenedKeys].join(", ")}) — an element's raw-vs-screened choice must be declared or it drifts between runs`,
      });
    }
  }
  return issues;
}

// ── Unscreened-superlative lint (run-35: screens vanished, raw peak shipped) ──

/** A peak/max finding whose value dwarfs its own chart column's median
 *  (>50x) with no screened variant anywhere is a transcription error
 *  promoted to a finding — the outlier-screen policy as a deterministic
 *  detector, so it survives runs where no screen was declared at all. */
export function lintUnscreenedSuperlative(
  chartData: Record<string, unknown>,
  findings: FindingEntry[]
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  const anyScreened = Object.values(chartData).some((v) => {
    const rows = Array.isArray(v) ? v : (v as { rows?: unknown[] } | null)?.rows;
    return (
      Array.isArray(rows) &&
      rows.length > 0 &&
      typeof rows[0] === "object" &&
      Object.keys(rows[0] as object).some((c) => /_screened/.test(c))
    );
  });
  for (const f of findings) {
    if (!/peak|max|largest/.test(f.name) || f.value === null || typeof f.value !== "object")
      continue;
    const val = (f.value as Record<string, unknown>).value;
    if (typeof val !== "number") continue;
    const tokens = f.name
      .split(/[._]/)
      .filter((t) => t.length > 2 && !["peak", "max", "largest"].includes(t));
    for (const v of Object.values(chartData)) {
      const rows = Array.isArray(v) ? v : (v as { rows?: unknown[] } | null)?.rows;
      if (!Array.isArray(rows) || rows.length < 5 || typeof rows[0] !== "object") continue;
      const col = Object.keys(rows[0] as object).find(
        (c) => !/_screened/.test(c) && tokens.some((t) => c.includes(t))
      );
      if (!col) continue;
      const nums = (rows as Record<string, unknown>[])
        .map((r) => r[col])
        .filter((x): x is number => typeof x === "number" && x > 0)
        .sort((a, b) => a - b);
      if (nums.length < 5) continue;
      const median = nums[Math.floor(nums.length / 2)];
      if (median > 0 && val > 50 * median && !anyScreened && issues.length < 3) {
        issues.push({
          kind: "unscreened_superlative",
          name: f.name,
          detail: `${f.name} = ${val} is ${Math.round(val / median)}x the median of ${col} with NO screened series in the payload — a magnitude outlier promoted to a finding (prior runs screened this; this run declared no screen at all)`,
        });
      }
      break;
    }
  }
  return issues;
}
