/**
 * Findings grammar tests: meta-schema drops, limits, last-wins merge,
 * the run-4 lints (derivation contradiction, cross-step), and the
 * composer projection's privacy properties.
 */
import { describe, it, expect } from "vitest";
import {
  validateFindings,
  mergeDeclarations,
  lintDerivations,
  lintCrossStepDerivations,
  lintCrossStepReconciliation,
  projectFinding,
  projectManifestForPrompt,
  namespaceFindings,
  scrubNumerals,
  MANIFEST_MAX_ENTRIES,
} from "@/lib/findings";
import type { FindingEntry } from "@/lib/contracts/findings";

const entry = (over: Partial<FindingEntry> = {}): FindingEntry => ({
  name: "churn_rate_trend",
  definition: "OLS direction of monthly_churn_rate over 2024",
  dtype: "direction",
  value: "falling",
  code_ref: "script.py:41",
  ...over,
});

describe("validateFindings", () => {
  it("keeps valid entries and versions the envelope", () => {
    const v = validateFindings([entry()], { referenceNames: ["monthly_churn_rate"] });
    expect(v.manifest.manifest_version).toBe("1.0");
    expect(v.manifest.findings).toHaveLength(1);
    expect(v.issues).toHaveLength(0);
  });

  it("drops meta-schema violations (dotted names, missing fields) without failing", () => {
    const v = validateFindings([
      entry({ name: "step_2.smuggled" }), // dots reserved for namespacing
      { name: "no_value_field", definition: "long enough definition", dtype: "scalar" },
      entry({ name: "ok_one" }),
    ]);
    expect(v.manifest.findings.map((f) => f.name)).toEqual(["ok_one"]);
    expect(v.issues.map((i) => i.kind)).toEqual(["meta_schema", "meta_schema"]);
  });

  it("drops oversized values and truncates oversized manifests", () => {
    const big = entry({
      name: "table_dump",
      value: Array.from({ length: 500 }, (_, i) => ({ i, v: i * 2 })),
    });
    const v = validateFindings([big, entry()]);
    expect(v.droppedCount).toBe(1);
    expect(v.issues[0].kind).toBe("value_too_large");

    const many = Array.from({ length: MANIFEST_MAX_ENTRIES + 5 }, (_, i) =>
      entry({ name: `f_${i}`, value: i })
    );
    const t = validateFindings(many);
    expect(t.manifest.findings.length).toBe(MANIFEST_MAX_ENTRIES);
    expect(t.issues.some((i) => i.kind === "manifest_truncated")).toBe(true);
  });

  it("flags (never drops) definitions anchored to no known column", () => {
    const v = validateFindings([entry({ definition: "a vague statement about things" })], {
      referenceNames: ["monthly_churn_rate"],
    });
    expect(v.manifest.findings).toHaveLength(1);
    expect(v.issues[0].kind).toBe("definition_unanchored");
  });
});

describe("mergeDeclarations", () => {
  it("last declaration wins with a visible redeclarations counter", () => {
    const merged = mergeDeclarations([
      entry({ value: "rising" }),
      entry({ value: "falling" }),
      entry({ name: "other", value: 1 }),
    ]);
    const trend = merged.find((f) => f.name === "churn_rate_trend")!;
    expect(trend.value).toBe("falling");
    expect(trend.redeclarations).toBe(1);
    expect(merged.find((f) => f.name === "other")!.redeclarations).toBe(0);
  });
});

describe("lintDerivations — the run-4 lint", () => {
  const decomposition = entry({
    name: "rate_vs_volume_split",
    dtype: "shares",
    value: { rate: 1317.3, volume: 203.8, dominant: "rate" },
  });

  it("flags a verdict naming the non-dominant term of its decomposition", () => {
    const verdict = entry({
      name: "base_effect",
      dtype: "verdict",
      value: "volume amplifying",
      derived_from_findings: ["rate_vs_volume_split"],
    });
    const issues = lintDerivations([decomposition, verdict]);
    expect(issues.map((i) => i.kind)).toContain("derivation_contradiction");
  });

  it("accepts a verdict agreeing with the dominant term; flags unknown refs", () => {
    const ok = entry({
      name: "base_effect",
      value: "rate driven",
      derived_from_findings: ["rate_vs_volume_split"],
    });
    expect(lintDerivations([decomposition, ok])).toHaveLength(0);
    const dangling = entry({ name: "x_measure", derived_from_findings: ["ghost"] });
    expect(lintDerivations([dangling]).map((i) => i.kind)).toEqual(["unresolved_lineage"]);
  });
});

describe("cross-step lints (1-based step_N vs 0-based depends_on)", () => {
  it("allows derivations inside the DAG and flags those outside it", () => {
    const f = entry({
      name: "combined",
      derived_from_findings: ["step_2.trend", "step_5.gap"],
    });
    // Declaring step 6, depends_on [1] → step_2 ok (2-1=1 ∈ set), step_5 not.
    const issues = lintCrossStepDerivations([f], 6, [1]);
    expect(issues).toHaveLength(1);
    expect(issues[0].detail).toContain("step 5");
  });

  it("reconciliation: same measure, different steps, materially different values", () => {
    const a = entry({
      name: "step_1.churn_rate",
      dtype: "scalar",
      unit: "pct",
      value: 7.6,
      derived_from_columns: ["churned"],
    });
    const b = entry({
      name: "step_3.churn_rate",
      dtype: "scalar",
      unit: "pct",
      value: 12.9,
      derived_from_columns: ["churned"],
    });
    const issues = lintCrossStepReconciliation([a, b]);
    expect(issues.map((i) => i.kind)).toEqual(["cross_step_reconciliation"]);
    expect(lintCrossStepReconciliation([a, { ...b, value: 7.65 }])).toHaveLength(0);
  });
});

describe("projection — the privacy boundary", () => {
  it("strips values, keeps field NAMES, scrubs numerals from definitions", () => {
    const p = projectFinding(
      entry({
        definition: "August spike of 4.4pp vs 0.2 baseline in monthly_churn_rate",
        value: { rate: 1317.3, volume: 203.8, dominant: "rate" },
      })
    );
    expect(JSON.stringify(p)).not.toContain("1317");
    expect(JSON.stringify(p)).not.toContain("4.4");
    expect(p.value_fields).toEqual(["rate", "volume", "dominant"]);
    expect(p.definition).toContain("⟨n⟩");
  });

  it("years survive scrubbing; data-like numbers do not", () => {
    expect(scrubNumerals("churn over 2024 rose 4.4pp")).toBe("churn over 2024 rose ⟨n⟩pp");
  });

  // Run 77051c9d: leafFields drops null leaves, so a step_change that found
  // NOTHING projected as {value_fields: ["baseline_spread"]} — one bindable
  // number under a definition promising "the largest period-over-period jump
  // that stands out and persists". The planner wrote "The sharpest jump
  // between consecutive days measured 118.97", where 118.97 is baseline_spread
  // — a SCALE REFERENCE, not a detected delta. Every gate passed: the digit
  // was a binding, the ref resolved, the field was real and non-null. Binding
  // discipline proves a number is real; it cannot prove the sentence means the
  // right thing. So the projection now states the non-detection and withholds
  // every number, leaving nothing to misuse.
  it("marks a non-detection and withholds its secondary numbers", () => {
    const p = projectFinding(
      entry({
        name: "daily_spend_step_change",
        dtype: "step_change",
        definition: "largest period-over-period jump that stands out and persists",
        value: { period: null, delta: null, direction: null, baseline_spread: 118.97 },
      })
    );
    expect(p.detected).toBe(false);
    expect(p.value_fields).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("baseline_spread");
  });

  it("leaves a DETECTED claim's fields alone", () => {
    const p = projectFinding(
      entry({
        name: "daily_spend_step_change",
        dtype: "step_change",
        value: { period: "2026-07-09", delta: 118.97, direction: "up", baseline_spread: 40.2 },
      })
    );
    expect(p.detected).toBeUndefined();
    expect(p.value_fields).toEqual(["period", "delta", "direction", "baseline_spread"]);
  });

  it("never blanks a dtype it has no primary-field map for", () => {
    const p = projectFinding(
      entry({ name: "custom_thing", dtype: "bespoke", value: { a: null, b: 3 } })
    );
    expect(p.detected).toBeUndefined();
    expect(p.value_fields).toEqual(["b"]);
  });

  it("prompt budget drops WHOLE entries, untagged first, and reports omissions", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      entry({
        name: `finding_${i}`,
        definition: `measure ${"x".repeat(80)} of monthly_churn_rate #${i}`,
        tags: i < 5 ? ["trend"] : undefined,
      })
    );
    const { projections, omitted } = projectManifestForPrompt(many);
    expect(omitted.length).toBeGreaterThan(0);
    expect(projections.length + omitted.length).toBe(200);
    for (let i = 0; i < 5; i++) {
      expect(projections.some((p) => p.name === `finding_${i}`)).toBe(true);
    }
  });
});

describe("namespaceFindings", () => {
  it("prefixes names and bare derivations; leaves qualified refs alone", () => {
    const [f] = namespaceFindings(3, [
      entry({ derived_from_findings: ["local_measure", "step_1.upstream"] }),
    ]);
    expect(f.name).toBe("step_3.churn_rate_trend");
    expect(f.derived_from_findings).toEqual(["step_3.local_measure", "step_1.upstream"]);
  });
});

describe("depth cap accepts per-group findings (run-9 regression)", () => {
  it("keeps a depth-3 per-segment structure that the old cap dropped", () => {
    // segment_trend_heterogeneity from the real run: root -> slopes -> segment -> leaf.
    const entry = {
      name: "segment_trend_heterogeneity",
      definition: "per-segment churn_rate trend slopes with heterogeneity test",
      dtype: "distribution",
      value: {
        significant: true,
        p_value: 9.123e-7,
        slopes: {
          Enterprise: { direction: "rising", slope_per_period: 0.00115 },
          "Self-Serve": { direction: "rising", slope_per_period: 0.0136 },
        },
      },
    };
    const { manifest, issues } = validateFindings([entry]);
    expect(manifest.findings).toHaveLength(1);
    expect(issues).toHaveLength(0);
  });
});
