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
