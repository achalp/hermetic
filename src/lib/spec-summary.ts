import type { Spec } from "@json-render/react";

interface UIElementLike {
  type: string;
  props: Record<string, unknown>;
  children?: string[];
}

/**
 * The summarizers only WALK a generic element tree — they never rely on the
 * full json-render Spec type. Accepting the loose shape (what history/
 * conversation storage actually hold) removes the `as unknown as Spec`
 * assertion that three call sites repeated identically: a Spec shape change
 * would have broken all three silently.
 */
export type SpecLike = Pick<Spec, never> & {
  root?: unknown;
  elements?: unknown;
};

/**
 * Produce a compact text summary of a spec for conversation context.
 * Much smaller than sending the full JSON to the LLM.
 */
export function summarizeSpec(spec: SpecLike): string {
  const elements = spec.elements as Record<string, UIElementLike> | undefined;
  if (!elements || typeof spec.root !== "string" || !spec.root) return "";
  const lines: string[] = [];
  walkElement(spec.root, elements, lines, 0);
  return lines.join("\n");
}

function walkElement(
  key: string,
  elements: Record<string, UIElementLike>,
  lines: string[],
  depth: number
): void {
  const el = elements[key];
  if (!el) return;

  const indent = "  ".repeat(depth);
  const label = extractLabel(el.type, el.props);
  lines.push(`${indent}- ${el.type}${label ? `: ${label}` : ""}`);

  // Walk children
  if (el.children) {
    for (const childKey of el.children) {
      walkElement(childKey, elements, lines, depth + 1);
    }
  }
}

function extractLabel(component: string, props: Record<string, unknown>): string {
  switch (component) {
    case "TextBlock":
      return truncate(String(props.content ?? ""), 60);
    case "StatCard":
      return `${props.label}: ${props.value}`;
    case "BarChart":
    case "LineChart":
    case "AreaChart":
    case "PieChart":
    case "ScatterChart":
    case "MapView":
    case "Histogram":
    case "BoxPlot":
    case "HeatMap":
    case "ViolinChart":
      return String(props.title ?? "");
    case "Annotation":
      return String(props.title ?? "");
    case "DataTable":
      return props.caption ? String(props.caption) : "";
    case "SelectControl":
    case "NumberInput":
    case "ToggleSwitch":
    case "TextInput":
    case "TextArea":
      return String(props.label ?? "");
    case "DataController":
      return `${(props.filters as unknown[])?.length ?? 0} filters, ${(props.outputs as unknown[])?.length ?? 0} outputs`;
    case "FormController":
      return `${(props.fields as unknown[])?.length ?? 0} fields`;
    default:
      return "";
  }
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

/**
 * Return an ordered list of component type names that appear in the spec
 * (e.g. ["StatCard", "StatCard", "BarChart", "DataTable"]). Used by the
 * follow-up suggestion endpoint to tell the LLM what the user just saw.
 */
export function extractSpecComponentTypes(spec: SpecLike): string[] {
  const elements = spec.elements as Record<string, UIElementLike> | undefined;
  if (!elements || typeof spec.root !== "string" || !spec.root) return [];
  const types: string[] = [];
  const walk = (key: string) => {
    const el = elements[key];
    if (!el) return;
    types.push(el.type);
    if (el.children) for (const child of el.children) walk(child);
  };
  walk(spec.root);
  return types;
}

/**
 * Extract the LLM-generated methodology text from the spec.
 * The methodology is the final TextBlock with variant "body" (the LLM is
 * instructed to end with a plain-English methodology paragraph).
 * Falls back to concatenating all body-variant TextBlocks if only one exists.
 */
export function extractDescription(spec: SpecLike): string {
  const elements = spec.elements as Record<string, UIElementLike>;
  if (!elements || typeof spec.root !== "string") return "";

  // Collect body-variant TextBlocks in document order by walking the tree
  const bodyTexts: string[] = [];
  const walkForBody = (key: string) => {
    const el = elements[key];
    if (!el) return;
    if (el.type === "TextBlock") {
      const variant = el.props?.variant ?? "body";
      if (variant === "body" && el.props?.content) {
        bodyTexts.push(String(el.props.content));
      }
    }
    if (el.children) {
      for (const child of el.children) walkForBody(child);
    }
  };
  walkForBody(spec.root);

  // The methodology is typically the last body TextBlock
  if (bodyTexts.length > 0) return bodyTexts[bodyTexts.length - 1];
  return "";
}
