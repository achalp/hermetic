/**
 * Plan validation (specs/narrative-compiler-2026-08-09.md §1).
 *
 * Structural rules enforced BEFORE anything renders — the failure classes
 * the lint battery detects in generated prose are parse errors here:
 * no-narrative (ANSWER required), dangling refs, and fabricated caveat
 * mechanisms (CAVEAT may only reference checks; it renders only their
 * fields, so a free-text mechanism has no syntax).
 */
import { z } from "zod";
import type { FindingEntry } from "@/lib/contracts/findings";
import type { Plan, PlanNode, PlanOp } from "@/lib/contracts/plan";

export const PLAN_OPS = [
  "ANSWER",
  "TREND",
  "SHAPE",
  "PEAK",
  "ENDPOINT",
  "CONTRAST",
  "NOTE",
  "CAVEAT",
  "INSIGHT",
] as const;

export const PlanNodeSchema = z.object({
  id: z.string().min(1),
  op: z.enum(PLAN_OPS),
  refs: z.array(z.string()).default([]),
  text: z.string().optional(),
});

export const PlanSchema = z.object({ nodes: z.array(PlanNodeSchema).min(1).max(24) });

let planIdCounter = 0;
/** Monotonic node id — stable within a document, unique enough across one. */
export function nextPlanNodeId(): string {
  planIdCounter += 1;
  return `pn_${Date.now().toString(36)}_${planIdCounter.toString(36)}`;
}

export interface PlanValidation {
  ok: boolean;
  errors: string[];
}

const CHECK_DTYPES = new Set(["check", "screen"]);

export function validatePlan(plan: Plan, findings: FindingEntry[]): PlanValidation {
  const errors: string[] = [];
  const parsed = PlanSchema.safeParse(plan);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  const byName = new Map(findings.map((f) => [f.name, f]));
  const answers = plan.nodes.filter((n) => n.op === "ANSWER");
  if (answers.length !== 1) {
    errors.push(
      `exactly one ANSWER node is required (found ${answers.length}) — a dashboard without the answer in words is not an answer`
    );
  }
  const seen = new Set<string>();
  for (const n of plan.nodes) {
    if (seen.has(n.id)) errors.push(`duplicate node id ${n.id}`);
    seen.add(n.id);
    if (n.op === "INSIGHT") {
      if (!n.text?.trim()) errors.push(`INSIGHT node ${n.id} has no text`);
      continue; // refs optional for insight
    }
    if (n.text !== undefined) {
      errors.push(`node ${n.id} (${n.op}): free text is only representable on INSIGHT`);
    }
    if (n.refs.length === 0) errors.push(`node ${n.id} (${n.op}) references no claim`);
    for (const ref of n.refs) {
      const f = byName.get(ref);
      if (!f) {
        errors.push(`node ${n.id} (${n.op}) references unknown claim "${ref}"`);
        continue;
      }
      if (n.op === "CAVEAT" && !CHECK_DTYPES.has(f.dtype)) {
        errors.push(
          `CAVEAT node ${n.id} references "${ref}" (dtype ${f.dtype}) — caveats may only reference checks/screens; their fields are the only representable mechanism`
        );
      }
    }
  }
  const insights = plan.nodes.filter((n) => n.op === "INSIGHT");
  if (insights.length > 1) errors.push("at most one INSIGHT node (the quarantined free paragraph)");
  return { ok: errors.length === 0, errors };
}

/** Deterministic fallback plan — the compiled pipeline can NEVER fail to
 *  produce a dashboard (PE review §4.4): answer on the question-primary or
 *  first non-check claim, caveats for failed checks. */
export function defaultPlan(findings: FindingEntry[]): Plan {
  const nodes: PlanNode[] = [];
  const primary =
    findings.find((f) => f.tags?.includes("question-primary")) ??
    findings.find((f) => !CHECK_DTYPES.has(f.dtype)) ??
    findings[0];
  if (primary) nodes.push({ id: nextPlanNodeId(), op: "ANSWER", refs: [primary.name] });
  for (const f of findings) {
    if (
      CHECK_DTYPES.has(f.dtype) &&
      f.value !== null &&
      typeof f.value === "object" &&
      (f.value as Record<string, unknown>).passed === false
    ) {
      nodes.push({ id: nextPlanNodeId(), op: "CAVEAT", refs: [f.name] });
    }
  }
  return { nodes };
}

/** The op each claim dtype most naturally renders under (planner guidance
 *  + add_node default). */
export function opForDtype(dtype: string): PlanOp {
  switch (dtype) {
    case "direction":
    case "trend":
      return "TREND";
    case "superlative":
      return "PEAK";
    case "current_state":
      return "ENDPOINT";
    case "comparison":
    case "step_change":
      return "SHAPE";
    case "check":
    case "screen":
      return "CAVEAT";
    default:
      return "NOTE";
  }
}
