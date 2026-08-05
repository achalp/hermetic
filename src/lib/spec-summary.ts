import type { Spec } from "@/lib/contracts/spec";
import { truncate } from "@/lib/format";

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

/**
 * Label extraction is PRESENCE-driven, not type-driven: after the handful of
 * genuinely component-specific shapes, any element with a string `title`
 * (every chart in the catalog declares one) or `label` (the input controls)
 * is summarized from it. The old version enumerated chart types in a switch
 * that nothing kept in sync with the catalog — of ~60 catalog charts it
 * listed 10, so a new chart rendered fine but silently vanished from history
 * summaries and follow-up context (ARCH-11). A catalog-driven test now pins
 * that every component declaring `title` gets summarized.
 */
function extractLabel(component: string, props: Record<string, unknown>): string {
  switch (component) {
    case "TextBlock":
      return truncate(String(props.content ?? ""), 60);
    case "StatCard":
      return `${props.label}: ${props.value}`;
    case "DataTable":
      return props.caption ? String(props.caption) : "";
    case "DataController":
      return `${(props.filters as unknown[])?.length ?? 0} filters, ${(props.outputs as unknown[])?.length ?? 0} outputs`;
    case "FormController":
      return `${(props.fields as unknown[])?.length ?? 0} fields`;
  }
  // Generic: title (charts/annotations), then label (input controls). Only
  // strings — a {"$state": ...} binding must not stringify to noise.
  if (typeof props.title === "string" && props.title) return props.title;
  if (typeof props.label === "string" && props.label) return props.label;
  return "";
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
