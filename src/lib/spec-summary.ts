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

// ── Shared prose walker ──────────────────────────────────────────────

/** One piece of narrative text lifted from a spec element. */
export interface ProseItem {
  /** Component type the text came from (e.g. "TextBlock", "Annotation"). */
  type: string;
  /** TextBlock variant when declared (the catalog default is "body"). */
  variant?: string;
  /** Annotation-style title, when present. */
  title?: string;
  /** The prose body alone (trimmed, without the title). */
  content: string;
  /** Display text: "title: content" when both are present, else whichever is. */
  text: string;
}

export interface ExtractProseOpts {
  /**
   * Component types to lift prose from. Default: TextBlock + Annotation —
   * the catalog's text-bearing components. Names that do not exist in the
   * catalog silently extract nothing.
   */
  proseTypes?: readonly string[];
  /** Also collect StatCard label/value pairs whose value is a LITERAL (state bindings are skipped — those live in `results`). */
  statCards?: boolean;
}

export interface ExtractedProse {
  prose: ProseItem[];
  /** Headline figures from StatCards ([] unless opts.statCards). */
  stats: Array<{ label: string; value: number | string }>;
}

const DEFAULT_PROSE_TYPES: readonly string[] = ["TextBlock", "Annotation"];

/**
 * Yield the spec's elements in document order (a walk from the root), then
 * any elements unreachable from the root in insertion order — so narrative
 * text is never dropped just because a patch left an orphan. Handles the
 * no-root case (everything in insertion order) and cycles (visited set).
 */
function* iterateElements(spec: SpecLike): Generator<UIElementLike> {
  const elements = spec.elements as Record<string, UIElementLike> | undefined;
  if (!elements) return;
  const visited = new Set<string>();
  const walk = function* (key: string): Generator<UIElementLike> {
    if (visited.has(key)) return;
    visited.add(key);
    const el = elements[key];
    if (!el || typeof el.type !== "string") return;
    yield el;
    for (const child of el.children ?? []) yield* walk(child);
  };
  if (typeof spec.root === "string" && spec.root) yield* walk(spec.root);
  for (const [key, el] of Object.entries(elements)) {
    if (visited.has(key)) continue;
    visited.add(key);
    if (el && typeof el.type === "string") yield el;
  }
}

/**
 * THE spec prose walker. Every consumer that needs "the narrative text of a
 * spec" — history summaries, notebook export, (eventually) the MCP result
 * summary — extracts through this one function, so the set of text-bearing
 * component types lives in exactly ONE place. The alternative — each caller
 * enumerating types in its own switch — is the walker-goes-stale failure
 * mode extractLabel's comment documents (ARCH-11): a new catalog component
 * renders fine but silently vanishes from every summary.
 *
 * Prose comes from the text-bearing components' `content` (with a `text`
 * prop fallback); Annotation-style titles are kept with their body as
 * "title: content". Only string props are lifted — a {"$state": ...}
 * binding must not stringify to noise.
 */
export function extractProse(spec: SpecLike, opts: ExtractProseOpts = {}): ExtractedProse {
  const proseTypes = new Set(opts.proseTypes ?? DEFAULT_PROSE_TYPES);
  const prose: ProseItem[] = [];
  const stats: Array<{ label: string; value: number | string }> = [];

  for (const el of iterateElements(spec)) {
    const props = el.props ?? {};
    if (opts.statCards && el.type === "StatCard") {
      const label = typeof props.label === "string" ? props.label : null;
      const value = props.value;
      if (label && (typeof value === "number" || typeof value === "string")) {
        stats.push({ label, value });
      }
      continue;
    }
    if (!proseTypes.has(el.type)) continue;
    const raw = props.content ?? props.text;
    const content = typeof raw === "string" ? raw.trim() : "";
    const title =
      typeof props.title === "string" && props.title.trim() ? props.title.trim() : undefined;
    if (!content && !title) continue;
    prose.push({
      type: el.type,
      variant: typeof props.variant === "string" ? props.variant : undefined,
      title,
      content,
      text: title ? (content ? `${title}: ${content}` : title) : content,
    });
  }

  return { prose, stats };
}

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
  // Body-variant TextBlocks in document order, via the shared prose walker.
  const bodyTexts = extractProse(spec, { proseTypes: ["TextBlock"] }).prose.filter(
    (p) => (p.variant ?? "body") === "body"
  );

  // The methodology is typically the last body TextBlock
  if (bodyTexts.length > 0) return bodyTexts[bodyTexts.length - 1].content;
  return "";
}
