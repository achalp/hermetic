/**
 * Every element must be REACHABLE from the root, or it does not exist.
 *
 * The renderer walks `root` through `children`. A child id that names an element
 * the composer never emitted is a dead end: that branch — and everything under
 * it — silently disappears, while the pipeline reports success.
 *
 * Observed (run 175e9f0a, "explain the housing gap in king county"): the spec's
 * root listed `['header-text', 'caveat-annotation', 'dc-main']` and `dc-main` was
 * never defined. Nine of twelve elements — three StatCards, an AreaChart, a
 * BarChart, a LineChart, two layout grids and the narrative — hung under it and
 * vanished. The user saw a title and a caveat. The analysis itself was perfect:
 * four chart series with real rows, all correctly bound. `meta.chartTypes`
 * recorded `['TextBlock','Annotation']`, so the system knew it had rendered
 * almost nothing and still called the run ok.
 *
 * The only prior guard was a PROMPT instruction (src/spec/react/schema.ts):
 * "SELF-CHECK: ... Every key in every children array must resolve to a defined
 * element." Asking the model to check its own work is not a guarantee.
 *
 * The repair reconstructs intent rather than pruning: the orphans are well-formed
 * and correctly bound, and the missing id is nearly always a CONTAINER the model
 * referenced and forgot to emit. Synthesizing that container preserves the
 * dashboard; dropping the dangling reference would throw the same nine elements
 * away, just deliberately.
 */
/**
 * Structural input, deliberately not the fully-typed `Spec`: this runs on a
 * PATCH-ASSEMBLED spec, whose elements are `Record<string, unknown>` off the
 * wire. Reachability only needs ids and `children`, so demanding the richer type
 * would force a cast at the call site and assert a shape nobody verified.
 */
export interface ReachableSpecLike {
  root?: string;
  elements?: Record<string, unknown>;
}

/** The one element shape this module synthesizes. */
interface SynthesizedContainer {
  type: "LayoutColumn";
  props: { gap: number };
  children: string[];
}

function childrenOf(element: unknown): string[] {
  if (!element || typeof element !== "object") return [];
  const kids = (element as { children?: unknown }).children;
  return Array.isArray(kids) ? kids.filter((k): k is string => typeof k === "string") : [];
}

export interface ReachabilityReport {
  /** Child ids referenced by some element but absent from the map. */
  missing: string[];
  /** Elements defined but not reachable from root, in declaration order. */
  orphaned: string[];
}

/** Walk from root and classify every id. Pure; mutates nothing. */
export function analyzeReachability(spec: ReachableSpecLike): ReachabilityReport {
  const elements = spec.elements ?? {};
  const seen = new Set<string>();
  const missing = new Set<string>();
  const stack: string[] = spec.root ? [spec.root] : [];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const el = elements[id];
    if (!el) {
      missing.add(id);
      continue;
    }
    for (const child of childrenOf(el)) stack.push(child);
  }
  return {
    missing: [...missing],
    // Declaration order, which is the order the composer intended them read.
    orphaned: Object.keys(elements).filter((id) => !seen.has(id)),
  };
}

export interface ReachabilityRepair {
  report: ReachabilityReport;
  /** Elements to ADD, keyed by id — empty when nothing needed repair. */
  synthesized: Record<string, SynthesizedContainer>;
  /** Orphans still unreachable after the repair (a structural failure). */
  unresolved: string[];
}

/**
 * Repair a spec whose tree lost a container.
 *
 * Only synthesizes when there is exactly ONE missing id: with several, the
 * mapping of orphans to containers is a guess, and inventing a layout the model
 * never described is worse than reporting the failure honestly.
 */
export function repairReachability(spec: ReachableSpecLike): ReachabilityRepair {
  const report = analyzeReachability(spec);
  const synthesized: Record<string, SynthesizedContainer> = {};
  if (report.missing.length === 1 && report.orphaned.length > 0) {
    synthesized[report.missing[0]!] = {
      type: "LayoutColumn",
      props: { gap: 16 },
      children: report.orphaned,
    };
    return { report, synthesized, unresolved: [] };
  }
  return { report, synthesized, unresolved: report.orphaned };
}
