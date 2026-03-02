import type { Spec } from "@json-render/react";

interface UIElementLike {
  type: string;
  props: Record<string, unknown>;
  children?: string[];
}

/**
 * Produce a compact text summary of a spec for conversation context.
 * Much smaller than sending the full JSON to the LLM.
 */
export function summarizeSpec(spec: Spec): string {
  const lines: string[] = [];
  const elements = spec.elements as Record<string, UIElementLike>;
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

function extractLabel(
  component: string,
  props: Record<string, unknown>
): string {
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
