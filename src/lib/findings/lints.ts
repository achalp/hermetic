/**
 * Findings coherence lints (spec §3.3, §7.2, §7.3) — pure, advisory.
 *
 * The posture matters more than the checks: entries are KEPT and flagged.
 * A wrong-but-visible verdict beats a silently dropped one.
 */
import type { FindingEntry, FindingIssue } from "@/lib/contracts/findings";
import type { ProductRolesIndex } from "@/lib/product";
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
 *
 * "One payload" means one POLICY SCOPE: in an Investigate merge each step is
 * its own analysis with its own legitimate policies, so cells are compared
 * only within a step (the step_N_/step_N. prefixes mark the scope), and a
 * step's superlative is checked only against that step's charts.
 */
export function lintChartConsistency(
  chartData: Record<string, unknown>,
  findings: FindingEntry[],
  rolesIdx?: ProductRolesIndex
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  // POLICY SCOPE: one analysis, one policy — but an Investigate run merges
  // MANY analyses, and different steps legitimately compute the same measure
  // under different scopes/screens. The step prefix is the deterministic
  // scope marker on both namespaces (step_N_ on merged chart keys, step_N.
  // on manifest names), so cells are compared only within their scope.
  // Single-shot Ask has no prefixes: everything shares scope "" — unchanged.
  const scopeOfKey = (k: string): string => /^(step_\d+)_/.exec(k)?.[1] ?? "";
  const scopeOfFinding = (name: string): string => /^(step_\d+)\./.exec(name)?.[1] ?? "";
  // Cell maps per scope: column -> xValue -> {nulls: series[], nums: Map<series, number>}
  type ByX = Map<string, { nulls: string[]; nums: Map<string, number> }>;
  const scopedCells = new Map<string, Map<string, ByX>>();
  const xKeyOf = (row: Record<string, unknown>): string | undefined => {
    for (const k of ["year", "month", "date", "period", "x", "label"]) {
      if (k in row) return String(row[k]);
    }
    return undefined;
  };
  for (const [series, v] of Object.entries(chartData)) {
    const rows = Array.isArray(v) ? v : (v as { rows?: unknown[] } | null)?.rows;
    if (!Array.isArray(rows)) continue;
    const cells = scopedCells.get(scopeOfKey(series)) ?? new Map<string, ByX>();
    scopedCells.set(scopeOfKey(series), cells);
    // Declared x role beats the well-known-key guess for declared series.
    const declaredX = rolesIdx?.get(series)?.xCol;
    for (const raw of rows) {
      if (raw === null || typeof raw !== "object") continue;
      const row = raw as Record<string, unknown>;
      const x = declaredX !== undefined ? String(row[declaredX]) : xKeyOf(row);
      if (x === undefined) continue;
      for (const [col, val] of Object.entries(row)) {
        if (col === declaredX) continue;
        if (["year", "month", "date", "period", "x", "label"].includes(col)) continue;
        const byX: ByX = cells.get(col) ?? new Map();
        cells.set(col, byX);
        const cell = byX.get(x) ?? { nulls: [] as string[], nums: new Map<string, number>() };
        byX.set(x, cell);
        if (val === null) cell.nulls.push(series);
        else if (typeof val === "number") cell.nums.set(series, val);
      }
    }
  }
  let divergences = 0;
  for (const cells of scopedCells.values()) {
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
  }
  // Superlative vs chart max: a peak/max finding whose value a chart column
  // exceeds — checked only against the finding's OWN scope's charts (a
  // step-2 peak over a screened subset is not contradicted by step-3's
  // unscreened chart of the full corpus).
  for (const f of findings) {
    if (!/peak|max/.test(f.name) || f.value === null || typeof f.value !== "object") continue;
    const val = (f.value as Record<string, unknown>).value;
    if (typeof val !== "number") continue;
    const cells = scopedCells.get(scopeOfFinding(f.name));
    if (!cells) continue;
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
    if (
      !/^(peak|trough|max|min|largest|smallest)_/.test(key) &&
      !/_(p_value|slope|slope_per_year|pct_change|r2|r_squared|pearson_r)$/.test(key)
    )
      continue;
    const toks = key.split(/[._]/).filter((t) => t.length > 2);
    const backed = findingTokens.some((ft) => toks.filter((t) => ft.has(t)).length >= 2);
    if (!backed && issues.length < 5) {
      issues.push({
        kind: "unbacked_superlative",
        detail: `results.${key} = ${val} has no finding backing it — a statistical claim shipped without the provenance the manifest exists to provide`,
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
  findings: FindingEntry[],
  rolesIdx?: ProductRolesIndex
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  // Structured path (exact, no morphology): a measure declared as a variant
  // with no screened_by is a transformation without a contract; a
  // screened_by naming a check the manifest doesn't carry is a dangling ref.
  const checkNames = new Set(findings.filter((f) => f.dtype === "check").map((f) => f.name));
  for (const [key, info] of rolesIdx ?? []) {
    for (const m of info.measures) {
      if (m.variant_of !== undefined && m.screened_by === undefined) {
        issues.push({
          kind: "undeclared_screen",
          detail: `series ${key} declares ${m.column} as a variant of ${m.variant_of} with no screened_by — a transformation with no declaration behind it (which rule, what threshold, how many excluded?)`,
        });
      } else if (m.screened_by !== undefined && !checkNames.has(m.screened_by)) {
        issues.push({
          kind: "undeclared_screen",
          detail: `series ${key} measure ${m.column} cites screened_by ${m.screened_by}, but no check with that name is declared — the screen reference dangles`,
        });
      }
    }
  }
  const screenedBases = new Set<string>();
  for (const [key, v] of Object.entries(chartData)) {
    if (rolesIdx?.has(key)) continue; // covered by the structured path above
    const rows = Array.isArray(v) ? v : (v as { rows?: unknown[] } | null)?.rows;
    if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== "object") continue;
    for (const col of Object.keys(rows[0] as Record<string, unknown>)) {
      const m = /^(.*?)_screened(?:_[a-z]+)?$/.exec(col);
      if (m) screenedBases.add(m[1]);
    }
  }
  // The EXECUTED-screen signature, independent of naming convention and of
  // whether the series was declared: a column null at rows where its _raw
  // sibling holds a value. Presence of the pair alone proves nothing; the
  // null-beside-raw divergence is a transformation that RAN (avg_price
  // null for 1986, avg_price_raw 13.68 — and no screen finding anywhere in
  // the manifest). Columns whose series declares the variant with a valid
  // screened_by are exempt — the structured path owns those.
  for (const [key, v] of Object.entries(chartData)) {
    const rows = Array.isArray(v) ? v : (v as { rows?: unknown[] } | null)?.rows;
    if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== "object") continue;
    const contracted = new Set(
      (rolesIdx?.get(key)?.screens ?? [])
        .filter((s) => checkNames.has(s.checkName))
        .map((s) => s.screenedCol)
    );
    const first = rows[0] as Record<string, unknown>;
    for (const col of Object.keys(first)) {
      const rm = /^(.*?)_raw$/.exec(col);
      if (!rm || !(rm[1] in first) || contracted.has(rm[1])) continue;
      const base = rm[1];
      const executed = (rows as Record<string, unknown>[]).some(
        (r) =>
          (r[base] === null || r[base] === undefined) && r[col] !== null && r[col] !== undefined
      );
      if (executed) screenedBases.add(base);
    }
  }
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

interface ScreenedColumnEntry {
  excludedX: Set<string>;
  rawKeys: Set<string>;
  screenedKeys: Set<string>;
  /** Checks declared to own this screen (analysis-product roles) — when
   *  present, scope lints deref these instead of token-matching. */
  checkNames: Set<string>;
}

function screenedColumnMap(
  chartData: Record<string, unknown>,
  rolesIdx?: ProductRolesIndex
): Map<string, ScreenedColumnEntry> {
  const map = new Map<string, ScreenedColumnEntry>();
  const X_KEYS = ["year", "month", "date", "period", "x", "label", "decade"];
  const newEntry = (): ScreenedColumnEntry => ({
    excludedX: new Set<string>(),
    rawKeys: new Set<string>(),
    screenedKeys: new Set<string>(),
    checkNames: new Set<string>(),
  });
  // Structured path (analysis-product spec §3): declared screened_by/
  // variant_of roles say exactly which column is a screen of which, under
  // which check — no name morphology involved. Keys covered by the roles
  // index are EXCLUDED from the legacy convention scan below.
  for (const [key, info] of rolesIdx ?? []) {
    const v = chartData[key];
    const rows = Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
    for (const screen of info.screens) {
      const base = screen.rawCol ?? screen.screenedCol;
      const entry = map.get(base) ?? newEntry();
      map.set(base, entry);
      entry.screenedKeys.add(key);
      entry.checkNames.add(screen.checkName);
      for (const row of rows) {
        if (typeof row !== "object" || row === null) continue;
        const rawVal = screen.rawCol !== undefined ? row[screen.rawCol] : undefined;
        const excluded =
          screen.rawCol !== undefined
            ? rawVal !== null && rawVal !== undefined && row[screen.screenedCol] === null
            : row[screen.screenedCol] === null;
        if (excluded) entry.excludedX.add(String(row[info.xCol]));
      }
    }
  }
  for (const [key, v] of Object.entries(chartData)) {
    if (rolesIdx?.has(key)) continue;
    const rows = Array.isArray(v) ? v : (v as { rows?: unknown[] } | null)?.rows;
    if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== "object") continue;
    const cols = Object.keys(rows[0] as Record<string, unknown>);
    for (const col of cols) {
      const m = /^(.*?)_screened(_[a-z]+)?$/.exec(col);
      if (!m) continue;
      const base = m[1] + (m[2] ?? "");
      const entry = map.get(m[1]) ?? newEntry();
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
    const info = rolesIdx?.get(key);
    if (info) {
      // A declared series consumes raw when a measure matches a screened
      // base and no measure in the same series screens it.
      for (const m of info.measures) {
        const base = m.column.replace(/_(usd|pct|pp)$/, "");
        const entry = map.get(base) ?? map.get(m.column);
        if (
          entry &&
          m.screened_by === undefined &&
          !info.screens.some((s) => s.rawCol === m.column)
        ) {
          entry.rawKeys.add(key);
        }
      }
      continue;
    }
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
  findings: FindingEntry[],
  rolesIdx?: ProductRolesIndex
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  for (const [base, entry] of screenedColumnMap(chartData, rolesIdx)) {
    if (entry.excludedX.size === 0) continue;
    // Structured path: screened_by names the owning check — dereference it
    // exactly. Legacy path: token-match check names/definitions.
    const declaring =
      entry.checkNames.size > 0
        ? findings.filter((f) => f.dtype === "check" && entry.checkNames.has(f.name))
        : findings.filter((f) => {
            const tokens = base.split(/_/).filter((t) => t.length > 2);
            return (
              f.dtype === "check" &&
              /screen|outlier|exclusion/.test(f.name + " " + f.definition.toLowerCase()) &&
              tokens.some((t) => f.name.includes(t) || f.definition.toLowerCase().includes(t))
            );
          });
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
export function lintSeriesConsumption(
  chartData: Record<string, unknown>,
  rolesIdx?: ProductRolesIndex
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  for (const [base, entry] of screenedColumnMap(chartData, rolesIdx)) {
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
  findings: FindingEntry[],
  rolesIdx?: ProductRolesIndex
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  for (const f of findings) {
    if (!/peak|max|largest/.test(f.name) || f.value === null || typeof f.value !== "object")
      continue;
    const val = (f.value as Record<string, unknown>).value;
    if (typeof val !== "number") continue;
    const tokens = f.name
      .split(/[._]/)
      .filter((t) => t.length > 2 && !["peak", "max", "largest"].includes(t));
    for (const [key, v] of Object.entries(chartData)) {
      const rows = Array.isArray(v) ? v : (v as { rows?: unknown[] } | null)?.rows;
      if (!Array.isArray(rows) || rows.length < 5 || typeof rows[0] !== "object") continue;
      const info = rolesIdx?.get(key);
      // Structured path: a measure declaring of=<finding> is the series view
      // of this finding — exact linkage, no token matching. Prefer the raw
      // variant when the of-measure is itself the screened one.
      const ofMeasure = info?.measures.find((m) => m.of === f.name);
      const col =
        (ofMeasure ? (ofMeasure.variant_of ?? ofMeasure.column) : undefined) ??
        Object.keys(rows[0] as object).find(
          (c) => !/_screened/.test(c) && tokens.some((t) => c.includes(t))
        );
      if (!col) continue;
      const nums = (rows as Record<string, unknown>[])
        .map((r) => r[col])
        .filter((x): x is number => typeof x === "number" && x > 0)
        .sort((a, b) => a - b);
      if (nums.length < 5) continue;
      const median = nums[Math.floor(nums.length / 2)];
      if (median > 0 && val > 50 * median && issues.length < 3) {
        // Was THIS value screened? A screened sibling column with null at
        // the peak row means yes. A screen that exists but let the peak
        // through is the cluster-validation failure: a rolling baseline
        // computed on unscreened data lets errors vouch for each other
        // (1980's \$30,000 cleared 100x because 1966/72/75/77's errors
        // raised the bar).
        const screenedCol =
          info?.screens.find((s) => s.rawCol === col)?.screenedCol ??
          Object.keys(rows[0] as object).find((c) => c.startsWith(col) && /_screened/.test(c));
        const peakRow = (rows as Record<string, unknown>[]).find((r) => r[col] === val);
        const wasScreened = screenedCol && peakRow ? peakRow[screenedCol] === null : false;
        if (!wasScreened) {
          issues.push({
            kind: screenedCol ? "screen_missed_superlative" : "unscreened_superlative",
            name: f.name,
            detail: screenedCol
              ? `${f.name} = ${val} is ${Math.round(val / median)}x the median of ${col} and the screen let it through — a baseline computed on unscreened data lets error clusters validate each other; iterate the screen or use a robust (trimmed) baseline`
              : `${f.name} = ${val} is ${Math.round(val / median)}x the median of ${col} with NO screened series in the payload — a magnitude outlier promoted to a finding`,
          });
        }
      }
      break;
    }
  }
  return issues;
}

// ── Well-attested-screened lint (run-37: 2012/$38 on 1,312 listings deleted) ──

/** A screen exists to remove transcription errors — which are low-n or
 *  magnitude-implausible. A screened-out x whose COUNT column is at or
 *  above the series median is well-attested data: screening it means the
 *  baseline is miscalibrated (a global pooled median on a trending series
 *  flags growth as error). */
export function lintWellAttestedScreened(
  chartData: Record<string, unknown>,
  rolesIdx?: ProductRolesIndex
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  const X_KEYS = ["year", "month", "date", "period", "x", "label", "decade"];
  for (const [key, v] of Object.entries(chartData)) {
    const rows = Array.isArray(v) ? v : (v as { rows?: unknown[] } | null)?.rows;
    if (!Array.isArray(rows) || rows.length < 5 || typeof rows[0] !== "object") continue;
    const cols = Object.keys(rows[0] as Record<string, unknown>);
    // Declared roles are authoritative when this key is a declared series.
    const info = rolesIdx?.get(key);
    const countCol =
      info?.countCol ??
      cols.find((c) => /(^|_)(item_count|n_items|count|listings|n_obs|observations)($|_)/.test(c));
    const xCol = info?.xCol ?? cols.find((c) => X_KEYS.includes(c.toLowerCase()));
    if (!countCol || !xCol) continue;
    const counts = (rows as Record<string, unknown>[])
      .map((r) => r[countCol])
      .filter((x): x is number => typeof x === "number")
      .sort((a, b) => a - b);
    if (counts.length < 5) continue;
    const medianCount = counts[Math.floor(counts.length / 2)];
    // Screen pairs: declared roles when available, name morphology otherwise.
    const pairs = info
      ? info.screens
          .filter((s) => s.rawCol !== undefined)
          .map((s) => ({ screened: s.screenedCol, base: s.rawCol!, label: s.rawCol! }))
      : cols.flatMap((col) => {
          const m = /^(.*?)_screened/.exec(col);
          const base = m && cols.find((c) => c.startsWith(m[1]) && !/_screened/.test(c));
          return m && base ? [{ screened: col, base, label: m[1] }] : [];
        });
    for (const { screened, base, label } of pairs) {
      for (const r of rows as Record<string, unknown>[]) {
        if (
          r[screened] === null &&
          typeof r[base] === "number" &&
          typeof r[countCol] === "number" &&
          (r[countCol] as number) >= medianCount &&
          issues.length < 3
        ) {
          issues.push({
            kind: "well_attested_screened",
            detail: `${key}: ${label} screened out at ${String(r[xCol])} despite ${String(r[countCol])} ${countCol} (>= series median ${medianCount}) — transcription errors are low-n or magnitude-implausible; a well-attested value screened means the baseline is miscalibrated (use a rolling/within-era baseline on trending series, never a global pooled one)`,
          });
        }
      }
    }
  }
  return issues;
}

/** Two representations of one absence: a finding field is null while its
 *  mirrored results key is 0 (run-37: step_change_delta 0 in results, null
 *  in the finding) — the mirror must be read, not re-defaulted. */
export function lintNullZeroMirror(
  results: Record<string, unknown>,
  findings: FindingEntry[]
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  for (const f of findings) {
    if (f.value === null || typeof f.value !== "object" || Array.isArray(f.value)) continue;
    for (const [field, val] of Object.entries(f.value as Record<string, unknown>)) {
      const base = f.name.replace(/^step_\d+\./, "");
      for (const rk of [`${base}_${field}`, `${field}`]) {
        if (!(rk in results) || issues.length >= 4) continue;
        if (val === null && results[rk] === 0) {
          issues.push({
            kind: "null_zero_mirror",
            name: f.name,
            detail: `results.${rk} = 0 while ${f.name}.${field} is null — two representations of the same absence; the results mirror must READ the declared dict (0 asserts a measurement that returned nothing)`,
          });
        } else if (val !== null && typeof val === "number" && results[rk] === null) {
          // Inverse loss (run-41: results.median_price_skewness null while
          // the manifest's distribution carries skew 4.25).
          issues.push({
            kind: "mirror_dropped_value",
            name: f.name,
            detail: `results.${rk} is null while ${f.name}.${field} = ${val} — results dropped a value its own manifest carries; the mirror must READ the declared dict`,
          });
        }
      }
    }
  }
  return issues;
}

/** An attestation-screened superlative narrated WITHOUT its raw extreme:
 *  the audit caught "peaked at 0.4" shipped while the raw max was 65x
 *  larger with 90% of years screened — the reader sees the screen's output
 *  but never learns a screen ran. Fires when the attested value appears in
 *  the narrative, differs materially from raw_value, and the raw value
 *  appears nowhere. Post-resolution narrative texts; advisory. */
export function lintSuperlativeHidesRaw(
  findings: FindingEntry[],
  narrativeTexts: string[]
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  if (narrativeTexts.length === 0) return issues;
  const text = narrativeTexts.join("\n");
  const renders = (v: number): string[] => {
    const out = [String(v)];
    if (Number.isInteger(v)) out.push(v.toLocaleString("en-US"));
    else out.push(v.toFixed(2), v.toFixed(1));
    return out;
  };
  // The same symmetry in both attestation-gated shapes: a superlative's
  // raw_value, and a current-state's latest_value (the reviewed run walked
  // back 68 thin years and the $26/2012 endpoint vanished from the story).
  const PAIRS: Array<{ rawField: string; periodField: string; scaleField: string }> = [
    { rawField: "raw_value", periodField: "raw_period", scaleField: "thin_periods_skipped" },
    { rawField: "latest_value", periodField: "latest_period", scaleField: "excluded_trailing" },
  ];
  for (const f of findings) {
    if (f.value === null || typeof f.value !== "object" || issues.length >= 3) continue;
    const fv = f.value as Record<string, unknown>;
    const val = fv.value;
    if (typeof val !== "number") continue;
    for (const { rawField, periodField, scaleField } of PAIRS) {
      const raw = fv[rawField];
      if (typeof raw !== "number") continue;
      if (Math.abs(raw - val) <= 0.2 * Math.max(Math.abs(val), 1e-9)) continue;
      const valShown = renders(val).some((r) => text.includes(r));
      const rawShown = renders(raw).some((r) => text.includes(r));
      if (valShown && !rawShown) {
        issues.push({
          kind: "superlative_hides_raw",
          name: f.name,
          detail: `${f.name} narrates the attested value ${val} while ${rawField} ${raw} (${String(fv[periodField] ?? "?")}${typeof fv[scaleField] === "number" ? `, ${scaleField}=${fv[scaleField]}` : ""}) appears nowhere — the gate may decide what the headline emphasizes, never what the reader can see; state both values`,
        });
        break;
      }
    }
  }
  return issues;
}

/** The regime envelope makes policy ENFORCEABLE: a series whose profile
 *  fired ZERO_INFLATED + MONETARY must have had its zeros excluded — a
 *  blocking check that CLAIMS record-level exclusion while reporting
 *  n_excluded=0 and leaving 12 $0.00 rows in the series is a check
 *  validating a filter that never ran (compiled-run review 2026-08-09). */
export function lintRegimePolicy(
  regimes: Record<string, unknown> | undefined,
  chartData: Record<string, unknown>,
  rolesIdx?: ProductRolesIndex
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  for (const [id, prof] of Object.entries(regimes ?? {})) {
    if (issues.length >= 3 || prof === null || typeof prof !== "object") continue;
    const flags = (prof as { flags?: unknown }).flags;
    if (!Array.isArray(flags) || !flags.includes("ZERO_INFLATED") || !flags.includes("MONETARY"))
      continue;
    const rows = chartData[id];
    if (!Array.isArray(rows) || rows.length === 0) continue;
    const info = rolesIdx?.get(id);
    const col = info?.measures[0]?.column;
    if (!col) continue;
    const zeros = (rows as Record<string, unknown>[]).filter((r) => r[col] === 0).length;
    if (zeros > 0) {
      issues.push({
        kind: "zero_sentinel_unapplied",
        name: id,
        detail: `series ${id}: the regime profile fired ZERO_INFLATED on a monetary measure (zero_share ${String((prof as Record<string, unknown>).zero_share)}), but ${zeros} zero-valued rows remain in ${col} — the sentinel policy was declared, not applied (a check claiming exclusion with n_excluded=0 is validating a filter that never ran); exclude at the record level via zero_policy(profile_regimes(...))`,
      });
    }
  }
  return issues;
}

/** An aggregation that didn't aggregate: a declared series whose x repeats
 *  consecutively with no group role — 34 rows tagged "(1850.999, 1916.0]"
 *  each carrying a single year's median is a per-year series wearing an
 *  era costume (and raw pandas Interval strings as labels). */
export function lintUnaggregatedRollup(
  chartData: Record<string, unknown>,
  rolesIdx?: ProductRolesIndex
): FindingIssue[] {
  const issues: FindingIssue[] = [];
  for (const [id, info] of rolesIdx ?? []) {
    if (issues.length >= 2 || info.groupCol) continue;
    const rows = chartData[id];
    if (!Array.isArray(rows) || rows.length < 4) continue;
    const xs = (rows as Record<string, unknown>[]).map((r) => String(r[info.xCol]));
    const dupRun = xs.some((x, i) => i > 0 && x === xs[i - 1]);
    const intervalLabels = xs.some((x) => /^[([][\d.]+, ?[\d.]+[)\]]$/.test(x));
    if (dupRun || intervalLabels) {
      issues.push({
        kind: "unaggregated_rollup",
        name: id,
        detail: `series ${id}: ${dupRun ? `x (${info.xCol}) repeats consecutively with no group role — the rollup never grouped (one row per underlying period wearing the bucket label)` : ""}${dupRun && intervalLabels ? "; " : ""}${intervalLabels ? "x labels are raw pandas Interval strings — name the buckets explicitly (e.g. '1850–1916'), str(Interval) is not a label" : ""}`,
      });
    }
  }
  return issues;
}

// ── Thin-superlative lint (run-39: 52-item year crowned the headline) ──

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
      definition:
        "computed by the analysis but never declared as a check — surfaced so its failure cannot pass silently",
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
    if (typeof results[`${base}_method`] !== "string") continue;
    if (`${base}_passed` in results) continue; // the checks surfacer owns it
    if (declared.some((d) => key.startsWith(`${d}_`) || d === base)) continue;
    const evidence: Record<string, unknown> = {};
    for (const [k2, v2] of Object.entries(results)) {
      if (!k2.startsWith(`${base}_`)) continue;
      const field = k2.slice(base.length + 1);
      if (v2 === null || typeof v2 !== "object") evidence[field] = v2;
    }
    added.push({
      name: base,
      dtype: "screen",
      definition:
        "an outlier screen computed by the analysis but never declared — surfaced so its result cannot pass silently",
      value: { passed: value === 0, evidence },
      tags: ["check", "caveat", "auto_surfaced"],
    } as FindingEntry);
    issues.push({
      kind: "undeclared_screen_computation",
      name: base,
      detail: `results carries a computed screen (${key} = ${value}, method ${String(results[`${base}_method`])}) with no declared finding behind it — the analysis should declare it via finding_outliers + declare_finding`,
    });
  }
  return { added, issues };
}
