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
import { resolvePurpose } from "@/lib/purpose-prompts";

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
  // Document grammar (spec §14):
  "SECTION",
  "EXPLAIN",
  "CALLOUT",
  "METHOD",
  "CONCLUSION",
  "NEXT_STEPS",
  "LIMITS",
] as const;

/** Ops that stand WITHOUT claim refs: a heading titles what follows, and
 *  next-steps/limits speak about the analysis, not a specific claim. */
export const REFLESS_OPS = new Set(["SECTION", "NEXT_STEPS", "LIMITS"]);
/** Ops whose whole content is authored text (no template fallback). */
export const TEXT_REQUIRED_OPS = new Set([
  "SECTION",
  "CALLOUT",
  "METHOD",
  "CONCLUSION",
  "NEXT_STEPS",
  "LIMITS",
]);

export const PlanNodeSchema = z.object({
  id: z.string().min(1),
  op: z.enum(PLAN_OPS),
  refs: z.array(z.string()).default([]),
  text: z.string().optional(),
  anchor: z.string().optional(),
});

export const PlanSchema = z.object({ nodes: z.array(PlanNodeSchema).min(1).max(32) });

/**
 * Purpose-scaled plan budgets (the compiled composer's depth dimension).
 * The generative composer receives getPurposePrompt(purpose); before this,
 * the compiled planner hard-coded "4-9 nodes" for every style — a compiled
 * deep-dive computed deep-dive-sized findings and then told a
 * dashboard-sized story (the observed "compiled looks leaner" gap). The
 * budget guidance is the compiled analog of the style FORM prompt; maxNodes
 * stays under PlanSchema's structural cap of 24.
 */
export const PLAN_BUDGETS: Record<string, { maxNodes: number; guidance: string }> = {
  brief: {
    maxNodes: 7,
    guidance:
      "4-7 nodes: ANSWER first — the bottom line in plain words. Then ONLY the claims that carry it; CAVEATs for failed checks. Close with a ONE-sentence METHOD (how the analysis was done, from the claims' definitions) and a one-sentence CONCLUSION — even a 30-second read must show how its answer was reached. Cut everything else.",
  },
  dashboard: {
    maxNodes: 12,
    guidance:
      "6-12 nodes: ANSWER first, then the findings that matter, CAVEATs anchored to the chart they qualify, at most one CALLOUT for what deserves attention. Close with a compact METHOD (1-2 sentences) and a CONCLUSION — a dashboard without its method reads as unsourced.",
  },
  report: {
    maxNodes: 22,
    guidance:
      "12-22 nodes, a COMPLETE document: open with METHOD (how the analysis was done, grounded in the claims' definitions), then SECTION-headed parts each weaving claims into flowing prose with EXPLAIN nodes anchored to their charts, CAVEATs anchored at the position they qualify, then CONCLUSION, NEXT_STEPS, and LIMITS to close. CONTRAST where claims tension.",
  },
  "deep-dive": {
    maxNodes: 28,
    guidance:
      "14-28 nodes, an exhaustive document: METHOD up front; SECTION-headed parts; narrate EVERY non-check claim that carries signal — an unnarrated finding is a coverage gap, not brevity; EXPLAIN anchored to every chart; CAVEATs anchored where they apply; CALLOUT for anything that deserves the reader's attention; close with CONCLUSION, NEXT_STEPS, and LIMITS.",
  },
};

/** The budget for a (possibly legacy/absent) purpose id — resolves through
 *  the same alias table as every other purpose consumer. */
export function planBudget(purpose?: string): { maxNodes: number; guidance: string } {
  return PLAN_BUDGETS[resolvePurpose(purpose)] ?? PLAN_BUDGETS.dashboard;
}

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

const BINDING_RE = /\$finding:([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)/g;

/** Validate AUTHORED narrative text (narrated compiled mode): every figure
 *  must be a binding — a literal digit anywhere outside a $finding: token
 *  is a fabrication vector and rejects the node (it falls back to the
 *  template). Bindings must resolve to a declared finding (longest-name
 *  match — names can be dotted) and a real field path, and the finding
 *  must be among the node's refs so the plan stays honest about sources. */
export function validateNodeText(text: string, refs: string[], findings: FindingEntry[]): string[] {
  const errors: string[] = [];
  const names = [...findings].sort((a, b) => b.name.length - a.name.length);
  const stripped = text.replace(BINDING_RE, "");
  if (/[0-9]/.test(stripped)) {
    errors.push(
      `literal figures in text ("${stripped.match(/[^\s]*[0-9][^\s]*/)?.[0]}") — every number, year, and percentage must be a $finding:<claim>.<field> binding`
    );
  }
  for (const m of text.matchAll(BINDING_RE)) {
    const path = m[1];
    const f = names.find((x) => path === x.name || path.startsWith(x.name + "."));
    if (!f) {
      errors.push(`binding ${m[0]} references no declared claim`);
      continue;
    }
    if (!refs.includes(f.name)) {
      errors.push(`binding ${m[0]} uses claim "${f.name}" — add it to the node's refs`);
    }
    const rest = path.slice(f.name.length).replace(/^\./, "");
    let v: unknown = f.value;
    let ok = true;
    for (const field of rest ? rest.split(".") : []) {
      if (v === null || typeof v !== "object") {
        ok = false;
        break;
      }
      v = (v as Record<string, unknown>)[field];
      if (v === undefined) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      errors.push(`binding ${m[0]}: field "${rest}" does not exist on "${f.name}"`);
      continue;
    }
    // Boolean gate (specs/finding-field-roles-2026-08-13.md §2.M2): a
    // yes/no flag has no word that belongs in a sentence slot — the
    // resolver refuses it downstream and the sentence used to strip,
    // which is how "spend shares sum to $finding:x.sums_to_100 of the
    // statement" became an EMPTY node (run f47eb42d). Rejected HERE, at
    // authoring time, the planner retries with an actionable message —
    // enforcement, not detection. String verdicts (direction,
    // excluded_reason, preferred) remain bindable by design.
    if (typeof v === "boolean") {
      errors.push(
        `binding ${m[0]} resolves to a yes/no flag — state the fact in words (e.g. "shares sum to 100%") instead of binding the flag`
      );
    }
  }
  return errors;
}

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
      else
        errors.push(
          ...validateNodeText(n.text, [...n.refs, ...findings.map((f) => f.name)], findings).map(
            (e) => `INSIGHT node ${n.id}: ${e}`
          )
        );
      continue; // refs optional for insight (bindings may cite any claim)
    }
    // Narrated compiled mode: any node MAY carry authored narrative text —
    // EXCEPT caveats (their fields are the only representable mechanism; a
    // free-text caveat is where fabricated mechanisms live).
    if (n.text !== undefined) {
      if (n.op === "CAVEAT") {
        errors.push(
          `CAVEAT node ${n.id}: free text is unrepresentable on caveats — checks render their declared fields verbatim`
        );
      } else {
        errors.push(
          ...validateNodeText(n.text, n.refs, findings).map((e) => `node ${n.id} (${n.op}): ${e}`)
        );
      }
    }
    if (n.op !== "CAVEAT" && TEXT_REQUIRED_OPS.has(n.op) && !n.text?.trim()) {
      errors.push(`node ${n.id} (${n.op}) requires authored text`);
    }
    if (n.refs.length === 0 && !REFLESS_OPS.has(n.op)) {
      errors.push(`node ${n.id} (${n.op}) references no claim`);
    }
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
  for (const [nodeId, op, token, firstId] of repeatedMappingBindings(plan, findings)) {
    errors.push(
      `node ${nodeId} (${op}): mapping ${token} already enumerated in node ${firstId} — a mapping binding renders as the full ranked enumeration; bind it once and reference it in words after`
    );
  }
  return { ok: errors.length === 0, errors };
}

/** Document-level mapping-once rule (run 9c415dc8): the full category
 *  ranking rendered verbatim in the ANSWER and again in the EXPLAIN. The
 *  planner prompt forbade it; nothing enforced it. A binding that resolves
 *  to a plain-object value renders as a full enumeration — the second node
 *  to bind it prints the same paragraph twice. Yields
 *  [nodeId, op, token, firstNodeId] per repeat. */
function repeatedMappingBindings(
  plan: Plan,
  findings: FindingEntry[]
): Array<[string, string, string, string]> {
  const names = [...findings].sort((a, b) => b.name.length - a.name.length);
  const seen = new Map<string, string>();
  const repeats: Array<[string, string, string, string]> = [];
  for (const n of plan.nodes) {
    if (!n.text) continue;
    for (const m of n.text.matchAll(BINDING_RE)) {
      const path = m[1];
      const f = names.find((x) => path === x.name || path.startsWith(x.name + "."));
      if (!f) continue;
      let v: unknown = f.value;
      for (const seg of path.slice(f.name.length).replace(/^\./, "").split(".").filter(Boolean)) {
        v = v !== null && typeof v === "object" ? (v as Record<string, unknown>)[seg] : undefined;
      }
      if (v === null || typeof v !== "object" || Array.isArray(v)) continue;
      const first = seen.get(m[0]);
      if (first !== undefined && first !== n.id) repeats.push([n.id, n.op, m[0], first]);
      else seen.set(m[0], n.id);
    }
  }
  return repeats;
}

/**
 * Per-node salvage (spec §14.2): validation failures degrade the OFFENDING
 * node, never the document. Before this, two failed planner attempts threw
 * away the whole authored document — one literal "2024" anywhere collapsed
 * a 12-node narrative to the template grab-bag (the observed quality
 * cliff). Salvage repairs what it can and drops only what it must:
 *  - invalid authored text → text stripped, node speaks its template
 *  - text on a CAVEAT → stripped (caveats render their check's fields)
 *  - unknown refs → dropped from the node; non-check refs off CAVEATs too
 *  - a text-required op left textless, or a node left refless → dropped
 *  - no ANSWER survives → a template ANSWER is injected (defaultPlan's rule)
 * The result is re-validated by the caller; only structural wreckage
 * (schema-level) still falls back to the full default plan.
 */
export function salvagePlan(
  plan: Plan,
  findings: FindingEntry[]
): { plan: Plan; repairs: string[] } {
  const byName = new Map(findings.map((f) => [f.name, f]));
  const repairs: string[] = [];
  const nodes: PlanNode[] = [];
  const seen = new Set<string>();
  let insightKept = false;
  for (const n of plan.nodes) {
    if (seen.has(n.id)) {
      repairs.push(`dropped duplicate node id ${n.id}`);
      continue;
    }
    seen.add(n.id);
    const node: PlanNode = { ...n };
    const unknown = node.refs.filter((r) => !byName.has(r));
    if (unknown.length > 0) {
      repairs.push(`node ${n.id} (${n.op}): dropped unknown refs ${unknown.join(", ")}`);
      node.refs = node.refs.filter((r) => byName.has(r));
    }
    if (node.op === "CAVEAT") {
      if (node.text !== undefined) {
        repairs.push(`CAVEAT ${n.id}: stripped free text (unrepresentable)`);
        delete node.text;
      }
      const checks = node.refs.filter((r) => CHECK_DTYPES.has(byName.get(r)!.dtype));
      if (checks.length < node.refs.length) {
        repairs.push(`CAVEAT ${n.id}: dropped non-check refs`);
        node.refs = checks;
      }
    } else if (node.op === "INSIGHT") {
      if (!node.text?.trim() || insightKept) {
        repairs.push(`dropped INSIGHT ${n.id} (${insightKept ? "second insight" : "no text"})`);
        continue;
      }
      const errs = validateNodeText(
        node.text,
        [...node.refs, ...findings.map((f) => f.name)],
        findings
      );
      if (errs.length > 0) {
        repairs.push(`dropped INSIGHT ${n.id}: ${errs[0]}`);
        continue;
      }
      insightKept = true;
    } else if (node.text !== undefined) {
      const errs = validateNodeText(node.text, node.refs, findings);
      if (errs.length > 0) {
        repairs.push(
          `node ${n.id} (${n.op}): authored text invalid (${errs[0]}) — template fallback`
        );
        delete node.text;
      }
    }
    if (node.op !== "CAVEAT" && node.op !== "INSIGHT") {
      if (TEXT_REQUIRED_OPS.has(node.op) && !node.text?.trim()) {
        repairs.push(`dropped ${node.op} ${n.id} — no valid authored text`);
        continue;
      }
      if (node.refs.length === 0 && !REFLESS_OPS.has(node.op)) {
        repairs.push(`dropped ${node.op} ${n.id} — no valid refs`);
        continue;
      }
    }
    if (node.op === "CAVEAT" && node.refs.length === 0) {
      repairs.push(`dropped CAVEAT ${n.id} — no valid check refs`);
      continue;
    }
    nodes.push(node);
  }
  // Mapping-once salvage: the degraded floor for a repeat enumeration is
  // losing the offending node's authored text (and the node itself when its
  // op cannot speak from a template) — never the document.
  const repeats = repeatedMappingBindings({ nodes }, findings);
  if (repeats.length > 0) {
    const drop = new Set<string>();
    for (const [nodeId, op, token, firstId] of repeats) {
      const node = nodes.find((x) => x.id === nodeId);
      if (!node || node.text === undefined) continue;
      delete node.text;
      repairs.push(
        `node ${nodeId} (${op}): stripped text re-enumerating ${token} (first bound in ${firstId})`
      );
      if (node.op === "INSIGHT" || TEXT_REQUIRED_OPS.has(node.op)) drop.add(nodeId);
    }
    if (drop.size > 0) {
      for (const id of drop) repairs.push(`dropped node ${id} — textless after mapping-once strip`);
      for (let i = nodes.length - 1; i >= 0; i--) if (drop.has(nodes[i].id)) nodes.splice(i, 1);
    }
  }
  const answers = nodes.filter((n) => n.op === "ANSWER");
  if (answers.length === 0) {
    const primary =
      findings.find((f) => f.tags?.includes("question-primary")) ??
      findings.find((f) => !CHECK_DTYPES.has(f.dtype)) ??
      findings[0];
    if (primary) {
      nodes.unshift({ id: nextPlanNodeId(), op: "ANSWER", refs: [primary.name] });
      repairs.push("injected template ANSWER node (none survived)");
    }
  } else if (answers.length > 1) {
    for (const extra of answers.slice(1)) {
      extra.op = "NOTE";
      repairs.push(`demoted extra ANSWER ${extra.id} to NOTE`);
    }
  }
  return { plan: { nodes }, repairs };
}

/** Deterministic fallback plan — the compiled pipeline can NEVER fail to
 *  produce a dashboard (PE review §4.4): answer on the question-primary or
 *  first non-check claim, caveats for failed checks. Purpose-scaled: under
 *  report/deep-dive budgets the fallback also narrates the remaining
 *  non-check claims via opForDtype — a planner failure on a deep-dive must
 *  not collapse the whole story to one sentence and its caveats. */
export function defaultPlan(findings: FindingEntry[], purpose?: string): Plan {
  const budget = planBudget(purpose);
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
  // Depth fill (report/deep-dive have headroom past ANSWER + caveats):
  // remaining non-check claims in declaration order, each under its
  // natural op, until the budget is spent. Caveats are never cut for
  // budget — honesty outranks form.
  for (const f of findings) {
    if (nodes.length >= budget.maxNodes) break;
    if (CHECK_DTYPES.has(f.dtype) || f.name === primary?.name) continue;
    nodes.push({ id: nextPlanNodeId(), op: opForDtype(f.dtype), refs: [f.name] });
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
