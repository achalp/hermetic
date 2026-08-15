import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FindingEntry } from "@/lib/contracts/findings";
import type { Plan, PlanNode } from "@/lib/contracts/plan";
import { realizeNode, realizeNodeTemplate } from "@/lib/compose/realizer";
import { resolveSpecPlaceholders } from "@/lib/llm/resolve-placeholders";
import { projectFinding } from "@/lib/findings/project";

/**
 * End-to-end replays of the two real runs that motivated
 * specs/finding-field-roles-2026-08-13.md, against their actual recorded
 * plans and findings (fixtures trimmed from data/history — user data that
 * gets pruned; the copies here are the permanent record).
 *
 *  - 77051c9d: the truncated clause ("…spanning group sizes of ") and the
 *    fabricated "sharpest jump" (baseline_spread of a NULL step change).
 *  - f47eb42d: the EMPTY ANSWER (an 11-entry shares_pct bound in the
 *    answer's only sentence) and the empty trend EXPLAIN (slope_ci95).
 *
 * The replay walks each recorded plan node through realizeNode (riders
 * included) and the resolver — the same seam the compiled pipeline uses —
 * and asserts the defect strings never reappear.
 */

interface Fixture {
  question: string;
  findings: { findings: FindingEntry[] };
  plan: { plan?: Plan } & Partial<Plan>;
  results: Record<string, unknown>;
}

const load = (name: string): Fixture =>
  JSON.parse(readFileSync(join(__dirname, "__fixtures__", name), "utf8")) as Fixture;

const nodesOf = (fx: Fixture): PlanNode[] => (fx.plan.plan ?? (fx.plan as Plan)).nodes;

/** Realize + resolve one node exactly as the compiled pipeline does:
 *  realizeNode (riders included) → resolver → and, when the resolved
 *  content comes back empty, the M5 post-render degradation to the node's
 *  deterministic template. The recorded f47eb42d plan NEEDS that last
 *  layer: its sums_to_100 EXPLAIN binds a boolean, which refuses — the
 *  boolean gate (M2) rejects such plans at authoring time now, but a
 *  recorded plan is exactly the degenerate input M5 exists for. */
function renderNode(node: PlanNode, findings: FindingEntry[], ridered: Set<string>): string | null {
  const byName = new Map(findings.map((f) => [f.name, f]));
  const vals = Object.fromEntries(findings.map((f) => [f.name, f.value]));
  const units = Object.fromEntries(
    findings.filter((f) => typeof f.unit === "string").map((f) => [f.name, f.unit as string])
  );
  const resolve = (text: string): string => {
    const out = resolveSpecPlaceholders(JSON.stringify({ content: text }), {}, {}, vals, units);
    return (JSON.parse(out) as { content: string }).content;
  };
  const text = realizeNode(node, byName, ridered);
  if (text === null) return null;
  const content = resolve(text);
  if (content.trim() !== "") return content;
  // M5: empty after resolution → deterministic template floor.
  const template = realizeNodeTemplate(node, byName);
  return template ? resolve(template) : content;
}

describe("replay: run f47eb42d (the EMPTY ANSWER)", () => {
  const fx = load("run-f47eb42d.json");
  const findings = fx.findings.findings;

  it("every authored plan node now renders non-empty prose", () => {
    const ridered = new Set<string>();
    for (const node of nodesOf(fx)) {
      if (node.op === "CAVEAT") continue; // renders check fields, tested elsewhere
      const content = renderNode(node, findings, ridered);
      expect(content, `${node.op} ${node.id} rendered empty`).toBeTruthy();
      expect(content!.trim(), `${node.op} ${node.id} rendered blank`).not.toBe("");
      expect(content).not.toContain("$finding");
    }
  });

  it("the ANSWER names the share breakdown instead of vanishing", () => {
    const answer = nodesOf(fx).find((n) => n.op === "ANSWER")!;
    const content = renderNode(answer, findings, new Set())!;
    // The recorded failure: this node's one sentence bound the 11-entry
    // shares_pct map, the map refused, the sentence stripped, the ANSWER
    // shipped as "". The value renderer now speaks it.
    expect(content).toContain("Other");
    expect(content.length).toBeGreaterThan(40);
  });

  it("the trend EXPLAIN renders its confidence interval as an interval", () => {
    const explain = nodesOf(fx).find(
      (n) => n.op === "EXPLAIN" && n.refs.includes("daily_spend_trend")
    )!;
    const content = renderNode(explain, findings, new Set())!;
    expect(content).toContain("-11.1527 to 11.5057");
  });

  it("the catch-all disclosure rides the authored answer", () => {
    // top_spend_category carries label_is_catchall: true in the recorded
    // manifest; the shipped run never surfaced it (realizer riders were
    // inert under authored text).
    const answer = nodesOf(fx).find((n) => n.op === "ANSWER")!;
    expect(answer.refs).toContain("top_spend_category");
    const content = renderNode(answer, findings, new Set())!;
    expect(content).toContain("catch-all bucket");
  });

  it("money renders as money throughout", () => {
    const ridered = new Set<string>();
    const all = nodesOf(fx)
      .map((n) => (n.op === "CAVEAT" ? null : renderNode(n, findings, ridered)))
      .filter(Boolean)
      .join(" ");
    expect(all).toContain("1,138.40");
    expect(all).not.toMatch(/\b1138\.4\b/);
  });
});

describe("replay: run 77051c9d (the truncated clause and the fabricated jump)", () => {
  const fx = load("run-77051c9d.json");
  const findings = fx.findings.findings;

  it("no rendered node ends mid-clause on a swept binding", () => {
    const ridered = new Set<string>();
    for (const node of nodesOf(fx)) {
      if (node.op === "CAVEAT") continue;
      const content = renderNode(node, findings, ridered);
      if (!content) continue;
      // The recorded failure ended "…spanning group sizes of " — a
      // preposition against nothing. No rendered sentence may do that.
      expect(content).not.toMatch(/\b(of|at|to|by|in|for)\s*[.!?]?\s*$/);
      expect(content).not.toContain("$finding");
    }
  });

  it("the null step-change projects as a non-detection with nothing to bind", () => {
    const sc = findings.find((f) => f.name === "daily_spend_step_change")!;
    const p = projectFinding(sc);
    // Legacy-tier inference (this fixture predates producer-declared
    // detected): all primary fields null ⇒ withheld.
    expect(p.detected).toBe(false);
    expect(p.value_fields).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("baseline_spread");
  });

  it("the template floor for the recorded ANSWER is non-empty (M5's backstop)", () => {
    const answer = nodesOf(fx).find((n) => n.op === "ANSWER")!;
    const byName = new Map(findings.map((f) => [f.name, f]));
    const t = realizeNodeTemplate(answer, byName);
    expect(t).toBeTruthy();
    expect(t!.length).toBeGreaterThan(20);
  });
});
