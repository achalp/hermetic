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
