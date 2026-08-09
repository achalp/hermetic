/**
 * Every human-facing word in the edit panel lives HERE — one file to keep
 * the language consistent and free of internal vocabulary (op codes,
 * finding ids, regime flags). The rule: rows speak in sentences and plain
 * kind words; machinery stays in tooltips at most.
 */
import type { PlanEditSurface } from "@/app/lib/api";

type Section = PlanEditSurface["sections"][number];
type ViewInfo = PlanEditSurface["views"][number];

/** Plain-language tag for a plan node's speech act. */
export const OP_LABEL: Record<string, string> = {
  ANSWER: "Answer",
  TREND: "Trend",
  SHAPE: "Pattern",
  PEAK: "Peak",
  ENDPOINT: "Endpoint",
  CONTRAST: "Comparison",
  NOTE: "Note",
  CAVEAT: "Caveat",
  INSIGHT: "Insight",
  SECTION: "Section",
  EXPLAIN: "Explainer",
  CALLOUT: "Callout",
  METHOD: "Method",
  CONCLUSION: "Conclusion",
  NEXT_STEPS: "Next steps",
  LIMITS: "Left out",
};

/** The row's tag chip: what KIND of thing this section is. */
export function sectionTag(s: Section): string {
  if (s.kind === "node") return OP_LABEL[s.op ?? ""] ?? "Text";
  if (s.kind === "tiles") return "Key numbers";
  if (s.kind === "banner") return s.id === "compiled_evidence_break" ? "Divider" : "Alert";
  return s.label.startsWith("Table") ? "Table" : "Chart";
}

/** The row's main line: the sentence for prose, the title for the rest. */
export function sectionTitle(s: Section): string {
  if (s.kind === "node") return s.preview || s.label;
  if (s.kind === "tiles") return "Headline stat tiles";
  if (s.id === "compiled_evidence_break") return "“Evidence” section divider";
  if (s.kind === "banner") return "Failed-check alert banner";
  // Server label is "Chart: Monthly Churn Rate (coverage)" — keep the name,
  // translate the parenthetical.
  return s.label
    .replace(/^Chart: /, "")
    .replace(/^Table: /, "")
    .replace(/\(coverage\)$/, "— observations per period")
    .replace(/\(unit split\)$/, "— separate axis");
}

/** What adding this catalog view gives the reader — benefit, not mechanism. */
export function viewBenefit(v: ViewInfo): string {
  switch (v.kind) {
    case "coverage":
      return "How many observations back each period — the evidence behind the thin-data calls.";
    case "table":
      return "The exact figures behind the charts, as a table.";
    case "unit_split":
      return "These measures use a different unit, so they get their own axis.";
    default:
      return "The main view of this data.";
  }
}

export function viewTitle(v: ViewInfo): string {
  const name = v.seriesId.replace(/^step_\d+_/, "").replace(/_/g, " ");
  switch (v.kind) {
    case "coverage":
      return `Coverage of ${name}`;
    case "table":
      return `Table of ${name}`;
    case "unit_split":
      return `${name} (separate axis)`;
    default:
      return name;
  }
}
